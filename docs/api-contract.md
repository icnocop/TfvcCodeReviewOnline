# How TFVC code review comments are stored and read

This is the contract the extension depends on. Microsoft's position is that "retrieving code review
comments programmatically isn't a supported feature", and there is no published documentation for
these routes, so everything here was established by calling them against a real Azure DevOps Server
collection.

Throughout, `{collectionUri}` means a team project collection root, for example
`https://tfs.example.com/DefaultCollection`.

## 1. Threads and comments

```http
GET {collectionUri}/_apis/discussion/threads?workItemId={id}&api-version=3.0-preview.1
```

That is the whole thing. It returns every thread on a Code Review Request work item, each with its
file path and line anchor, and every comment with its author already resolved and its `parentId`
intact for replies — exactly what Visual Studio's Code Review page displays.

> **The `workItemId` parameter is the key.** The same route also accepts `artifactUri`, and it is
> easy to conclude the route is useless for code reviews by passing the artifact URI you would
> expect it to want. `artifactUri=vstfs:///CodeReview/CodeReviewId/{projectId}/{workItemId}` returns
> an empty collection — that is *not* how code review discussions are keyed. What does work is
> either `workItemId`, or the shelveset artifact URI that appears as `artifactUri` in the results
> (`vstfs:///VersionControl/Shelveset/{name}%2526shelvesetOwner%253d{domain}%25255c{user}`).

### Response shape

```jsonc
{
  "count": 8,
  "value": [
    {
      "id": 21753,
      "artifactUri": "vstfs:///VersionControl/Shelveset/...",
      "workItemId": 23275,
      "status": "active",
      "publishedDate": "...",
      "lastUpdatedDate": "...",
      "properties": { /* see below */ },
      "comments": [
        {
          "id": 1,
          "threadId": 21753,
          "parentId": 1,               // absent on a root comment
          "author": { "id": "...", "displayName": "...", "uniqueName": "...", "imageUrl": "..." },
          "content": "...",            // real CRLF pairs for multi-line text
          "publishedDate": "...",
          "isDeleted": false,
          "commentType": "text"
        }
      ]
    }
  ]
}
```

Notes that matter in practice:

- **`properties` values are wrapped**, not plain: each is `{ "$type": "System.Int32", "$value": 117 }`.
- **Replies are flat.** Nesting is expressed only by `parentId`, which is *absent* on root comments.
  Rebuild the tree yourself, and be ready for an orphan whose parent was deleted.
- **Authors arrive resolved**, with `displayName` and an avatar URL. No separate identity lookup is
  needed. An author may still have no `displayName` — that happens for an account removed from the
  collection — so fall back to the raw id rather than rendering blank.

### Thread properties

| Property | Meaning |
| --- | --- |
| `Microsoft.TeamFoundation.Discussion.ItemPath` | Server path, e.g. `$/ExampleProject/src/Sample.cs` |
| `…Discussion.Position.StartLine` / `.EndLine` | 1-based line range of the anchor |
| `…Discussion.Position.StartColumn` / `.EndColumn` | Column range |
| `…Discussion.Position.StartCharPosition` / `.EndCharPosition` | Character offsets |
| `…Discussion.Position.PositionContext` | `RightBuffer` (reviewed side) or `LeftBuffer` (base side) |

### The three thread levels

There is no level field; it is inferred from which anchors are present:

| `ItemPath` | `Position` | Level | Where it belongs in a UI |
| --- | --- | --- | --- |
| absent | absent | **review** | Top of the review. The first such thread holds the review description. |
| present | absent | **file** | Top of that file. |
| present | present | **code block** | Anchored at the line range within that file. |

### Calling it from an extension

This is where an afternoon goes if you are not expecting it.

- **A hand-rolled `fetch` with a `VSS.getAccessToken()` bearer token is rejected with 401**, even
  though the identical token is accepted by the TFVC REST endpoints. Use the platform's own client
  instead — subclass `VssHttpClient` from `VSS/WebApi/RestClient` and call `_beginRequest`, which
  negotiates authentication the way Microsoft's generated clients do. The `discussion`/`threads`
  location ID is `a50ddbe2-1a1d-4c55-857f-73c6a3a31722`; see `ts/platform/vssPlatform.ts`.
- **Cookies are not an option.** Extension content runs in a sandboxed frame with an opaque origin,
  so requests are cross-origin *even though the host name matches the collection* — a CORS preflight
  arriving at all is the tell, since same-origin requests never preflight. The collection answers
  with `Access-Control-Allow-Origin: *`, which CORS forbids combining with credentials, so
  `credentials: 'include'` makes the browser discard the response before any script sees it. The
  symptom is a bare `NetworkError when attempting to fetch resource` plus a console note about
  `CORS No Allow Credentials`.

From PowerShell or any desktop client none of this applies: Windows integrated authentication works
directly, as `scripts/Export-CodeReviewComments.ps1` does.

## 2. What is under review: the work item fields

The Code Review Request work item is where a review's identity lives:

| Field | Meaning |
| --- | --- |
| `Microsoft.VSTS.CodeReview.ContextCode` | `1` = shelveset, `2` = changeset |
| `Microsoft.VSTS.CodeReview.ContextType` | The same thing as a string, for example `Shelveset` |
| `Microsoft.VSTS.CodeReview.Context` | Shelveset name, or changeset number |
| `Microsoft.VSTS.CodeReview.ContextOwner` | Identity **GUID** of the shelveset owner |

A Code Review Request also has one child **Code Review Response** work item per reviewer, carrying
`Microsoft.VSTS.CodeReview.ClosedStatus` (for example `With Comments`), `AcceptedBy`, and
`AcceptedDate`. Useful for reporting; it holds no thread content.

### Closing a review

A review is closed by a **work item state transition**, `Requested` → `Closed`. The work item type
definition does nearly all of it; a client supplies almost nothing. From the type's own workflow:

```xml
<TRANSITION from="Requested" to="Closed">
  <REASONS><DEFAULTREASON value="Closed" /></REASONS>
  <FIELDS>
    <FIELD refname="System.AssignedTo"><COPY from="value" value="" /></FIELD>
    <FIELD refname="Microsoft.VSTS.Common.ClosedBy"><COPY from="currentuser" /><VALIDUSER /></FIELD>
    <FIELD refname="Microsoft.VSTS.CodeReview.ClosedStatusCode"><COPY from="value" value="2" /></FIELD>
    <FIELD refname="Microsoft.VSTS.CodeReview.ClosedStatus"><COPY from="value" value="Checked-in" /></FIELD>
    <FIELD refname="Microsoft.VSTS.Common.ClosedDate"><SERVERDEFAULT from="clock" /></FIELD>
  </FIELDS>
  <ACTIONS>
    <ACTION value="Microsoft.VSTS.Actions.Checkin" />
    <ACTION value="Microsoft.VSTS.CodeReview.Abandon" />
  </ACTIONS>
</TRANSITION>
```

So a client writes **`System.State` = `Closed`**, plus `Microsoft.VSTS.CodeReview.ClosedStatus` when
it wants anything other than the transition's default. `ClosedBy`, `ClosedDate`, `System.Reason`,
`Microsoft.VSTS.Common.StateCode`, and the cleared `System.AssignedTo` are all filled in by the rules
above — writing them from a client would be duplicating work the server does anyway.

The two actions named in `<ACTIONS>` are the two Visual Studio offers on its **Close Review** menu:

| Visual Studio | `ClosedStatus` | `ClosedStatusCode` |
| --- | --- | --- |
| Complete | `Checked-in` | `2` |
| Abandon | `Abandoned` | `1` |

`ClosedStatusCode` is **read-only in the `Requested` state** and is kept in step with `ClosedStatus`
by a pair of mutual `WHEN`/`COPY` rules on the two fields (`0` ↔ empty, `1` ↔ `Abandoned`,
`2` ↔ `Checked-in`, `3` ↔ `Completed`). Do not write it: write the status string and let the rules
derive the code.

> **Do not read the stored pair as authoritative.** Closed reviews on a real collection hold
> combinations the rules above forbid — `Checked-in` with code `1`, `Abandoned` with code `2` — because
> the transition's unconditional `COPY` and the field-level `WHEN` rules both fire on the same save
> and the surviving value depends on which field the client set. Reporting on `ClosedStatus` is safe;
> reporting on `ClosedStatusCode` is not.

Also worth knowing: **there is no transition back.** The workflow defines `""` → `Requested` and
`Requested` → `Closed` and nothing else, so closing a review cannot be undone from any client.

## 3. The reviewed code: TFVC REST

Fully supported, and Microsoft's own `TFS/VersionControl/TfvcRestClient` handles it.

```http
GET {collectionUri}/_apis/tfvc/shelvesets/{Context};{ContextOwner}/changes?api-version=3.0
```

Each change carries `changeType`, `item.path`, `item.version` — the **base changeset**, the version
to diff against — and `item.url`, which returns the shelved file as `text/plain`. The base side comes
from `_apis/tfvc/items/{path}?versionType=Changeset&version={item.version}`.

> **Gotcha.** The `/shelvesets/{id}` route requires the **owner GUID** form, `name;{ownerGuid}`. The
> `name;DOMAIN\user` form returns 404 there — even though that is exactly the form the web UI uses in
> its `?ss=` query parameter and the form that appears in `item.url`'s own `version=` value. The work
> item stores the owner as a GUID already, so build the ID from `Context` and `ContextOwner`.

For a changeset review, use `_apis/tfvc/changesets/{id}/changes` with the base side at `{id-1}`.

### Querying by artifact URI

The threads carry an `artifactUri` naming the **shelveset**, and querying by that returns the same
threads as querying by work item:

```http
GET {collectionUri}/_apis/discussion/threads?artifactUri=vstfs:///VersionControl/Shelveset/{name}%2526shelvesetOwner%253d{DOMAIN}%25255c{user}
```

Verified side by side against the same review: four threads either way.

This is worth recording because of what it says about the built-in shelveset view. That page has
everything it needs to show these comments — it is displaying the very shelveset the threads are
filed against — and it does not ask for them. The comments are absent from it by omission, not
because they are unreachable from there.

`workItemId` remains the query this extension uses: it is the identifier the tab already has, and it
needs no encoding gymnastics. Note the double encoding in the artifact form (`%2526` → `%26` → `&`),
the same trap as when creating a thread.

## 4. Writing a reply

Replying is REST as well, on a `comments` resource of the same area. This was worth establishing
carefully, because the obvious assumption — that the undocumented SOAP `PublishDiscussions` operation
is the only way to write — is wrong, and acting on it would mean building a SOAP transport for no
reason. See the appendix.

Ask the collection what the area exposes:

```http
OPTIONS {collectionUri}/_apis/discussion
```

```
comments      _apis/{area}/{resource}
comments      _apis/{area}/threads/{discussionId}/{resource}/{commentId}    min=1.0  max=5.1
threads       _apis/{area}/{resource}
threads       _apis/{area}/{resource}/{discussionId}
threadsBatch  _apis/{area}/{resource}
```

A reply is a `POST` to that thread's comments, with `parentId` naming the comment being answered:

```http
POST {collectionUri}/_apis/discussion/threads/{threadId}/comments?api-version=3.0-preview.1
Content-Type: application/json

{ "content": "Agreed, fixed.", "parentId": 1, "commentType": "text" }
```

The response is the created comment, verified live:

```json
{ "id": 2, "parentId": 1, "threadId": 21760,
  "author": { "displayName": "...", "id": "..." },
  "content": "Agreed, fixed.",
  "publishedDate": "...", "lastUpdatedDate": "...", "canDelete": true, "commentType": "text" }
```

Notes from that verification:

- **Send only `content`, `parentId`, and `commentType`.** The server assigns `id` (per-thread, so the
  second comment in a thread is `2`), the author, and every date, and it updates the thread's own
  `lastUpdatedDate`. Sending any of those means fighting it for ownership of fields it alone can set.
- **The comment is authored as the caller**, so a reply is attributable to the person who wrote it
  rather than to a service identity.
- **`canDelete: true`** on every comment read back — the route pairs with a delete, which is how a
  test write can be undone.
- **The work item is not touched.** Its `rev`, `System.ChangedDate`, and `System.CommentCount` are all
  unchanged by the write. `System.CommentCount` does not track code review threads in any case: a
  review with 12 comments across 8 threads reported a count of 9.
- **Probing safely.** `POST` to a thread ID that cannot exist returns **404, not 405**, which
  establishes that the method is routed without creating anything.

## 5. Creating a thread

A reply goes into an existing thread. A comment *on* something — a file, or a block of code — is a
new thread, which is a `POST` to the threads route.

```http
POST {collectionUri}/_apis/discussion/threads?api-version=3.0-preview.1
Content-Type: application/json

{
  "workItemId": 23283,
  "artifactUri": "vstfs:///VersionControl/Shelveset/{name}%2526shelvesetOwner%253d{DOMAIN}%25255c{user}",
  "status": "active",
  "properties": {
    "Microsoft.TeamFoundation.Discussion.ItemPath": { "$type": "System.String", "$value": "$/Project/src/File.cs" }
  },
  "comments": [ { "content": "Is this file still needed?", "commentType": "text" } ]
}
```

Returns **201** with the created thread, its assigned `id`, and its properties echoed back.

- **`artifactUri` is required.** Omitting it fails with `400` and
  `Value cannot be null. Parameter name: The argument 'VersionUri' is null or empty.` — the server
  calls the field `VersionUri` internally, the same name the SOAP contract used for it.
- **Don't build that URI by hand.** It embeds the shelveset owner as `DOMAIN\user` and is encoded
  *twice* (`%2526` → `%26` → `&`, `%25255c` → `%5c` → `\`), and the work item only stores the owner as
  a GUID, so reproducing it means resolving an identity to an account name and matching the encoding
  exactly. Instead **copy it from any existing thread on the review**: every code review has at least
  the description thread, and its `artifactUri` is the one to reuse verbatim.
- **`properties` must use the `{ "$type", "$value" }` wrapper** on write, the same as on read.
- **`workItemId` is what associates the thread with the review**, and is what the read route queries.

Add the position properties to anchor the thread to a block of code instead of the whole file:

```json
"Microsoft.TeamFoundation.Discussion.Position.StartLine":       { "$type": "System.Int32",  "$value": 10 },
"Microsoft.TeamFoundation.Discussion.Position.EndLine":         { "$type": "System.Int32",  "$value": 11 },
"Microsoft.TeamFoundation.Discussion.Position.StartColumn":     { "$type": "System.Int32",  "$value": 1 },
"Microsoft.TeamFoundation.Discussion.Position.EndColumn":       { "$type": "System.Int32",  "$value": 1 },
"Microsoft.TeamFoundation.Discussion.Position.PositionContext": { "$type": "System.String", "$value": "RightBuffer" }
```

`StartCharPosition` and `EndCharPosition` — absolute character offsets from the start of the file to
the start of the given line — are **accepted but not required**: the server returns 201 either way and
echoes back only the properties that were sent. Visual Studio does write them, so writing them too is
the safer choice for client parity; they are computable from the file text the diff already fetches.

## Verifying this document

```powershell
.\scripts\Export-CodeReviewComments.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234
```

Run that after any Azure DevOps Server patch or upgrade against a review you know the shape of. If it
still renders the expected threads, replies, and file grouping, the contract holds.

## Appendix: the SOAP service, and why it is not used

There is also a SOAP endpoint at
`{collectionUri}/Discussion/V1.0/DiscussionWebService.asmx`, registered in the location service as
`DiscussionWebService`. It is what Visual Studio's Code Review page itself calls, and it exposes
three operations: `QueryDiscussionsByCodeReviewRequest(workItemId)`,
`QueryDiscussionsByVersion(versionUri)`, and
`PublishDiscussions(discussions, comments, deletedComments)`.

It serves the same data as the REST route, in an XML form where nearly every field is an **attribute**
rather than an element. This project used it initially and no longer does, for a decisive reason:
**it cannot be called from an extension.** It rejects the extension's access token with 401 no matter
which scopes are requested — the `.asmx` services predate the OAuth scope model, which is defined for
the REST surface only.

It remains the only known route for **writing** comments, so it is worth knowing about if replying
from the browser is ever attempted. That would need a server-side component; the wire format is
recoverable from the endpoint's own WSDL at `…/DiscussionWebService.asmx?WSDL`.
