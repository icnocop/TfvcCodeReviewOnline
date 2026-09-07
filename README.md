# TFVC Code Review Online

Read TFVC code review comments and replies in the Azure DevOps web UI.

TFVC code reviews have only ever been a Visual Studio feature. In the browser, Azure DevOps Server
shows you the Code Review Request work item and the shelveset diff, but none of the discussion — so
the review conversation is invisible unless you open Visual Studio. This extension adds a
**Comments** tab to the Code Review Request work item form that shows the threads, anchored to the
code they refer to, with replies nested underneath, the way a Git pull request does.

> **Status: working.** A navigation tree on the left, and on the right each changed file with a diff
> of the shelved version against its base changeset — inline or side by side — with every comment
> anchored to the line it refers to and replies nested underneath. You can reply to any thread,
> comment on a whole file, and select lines in a diff to comment on them. See [Roadmap](#roadmap).

## Why this needs to exist

- There is no first-party web UI for TFVC code review comments in **any** version of Azure DevOps
  Server — not 2019, 2020, 2022, or 2025. It has stayed a Visual Studio Team Explorer feature in
  every release, and Microsoft's documentation states that retrieving code review comments
  programmatically "isn't a supported feature". Upgrading the server will not give you this.
- No Marketplace extension surfaces them either, and the `CodeReview` REST area that exists
  on-premises is the internal service behind **Git** pull-request reviews, not TFVC reviews.

The data *is* reachable, though, through an undocumented but perfectly ordinary REST route:
`_apis/discussion/threads?workItemId={id}`. See [docs/api-contract.md](docs/api-contract.md) for the
full contract, which is documented nowhere else — including the trap that the same route's
`artifactUri` parameter returns nothing for the artifact URI you would expect a code review to use.

## How it works

```
Comments tab (extension frame)
  ├── work item form service ──> which shelveset or changeset is under review
  ├── _apis/discussion/threads ──> threads, comments, authors            (REST, undocumented)
  └── TfvcRestClient          ──> changed files and both sides of each  (REST, Microsoft's client)
```

All three calls go straight from the browser to the collection — there is no companion service and no
service account. They do not, however, all authenticate the same way, and the difference matters:

- **The discussion threads** are read with the reader's own credentials, so everyone sees exactly
  what their permissions allow. This is the sensitive half, and it is deliberately not routed through
  the platform's REST client.
- **The changed files and their content** go through Microsoft's `TfvcRestClient`, which authenticates
  with a delegated token instead. That token still represents the signed-in reader — it is their
  identity, restricted to the scopes the extension declares — so TFVC permissions are the reader's
  own here too. What the `vso.code` scope sets is the ceiling on what the extension may do on their
  behalf, not a different identity; remove the scope and the token can do nothing, which is why every
  diff fails with `TF400813` naming the reader.

Reading the discussion threads needs a **personal access token**, which the tab asks for once and
stores against your own account. That is a server limitation rather than a design choice: Azure
DevOps Server refuses an extension's delegated token at the discussion API while accepting a personal
access token for the identical request, and no scope changes it. The alternative is a small,
unsupported change to the server that removes the requirement — both are covered in
[docs/installing.md](docs/installing.md).

Worth knowing if you work on this: although extension assets are served from the Azure DevOps server
itself, those calls are **not** same-origin. Extension content is hosted in a sandboxed frame without
`allow-same-origin`, so it has an opaque origin, every request out of it is cross-origin even against
its own host name, and cookies cannot be sent. That single missing sandbox flag is the root of most
of the authentication behavior here.

## Requirements

- Azure DevOps Server 2019 or later, or Azure DevOps Services, with a TFVC repository.
- Reviews created by Visual Studio's **Request Review** flow (Code Review Request work items).

## Installing

Download the `.vsix` from the [releases page](https://github.com/icnocop/TfvcCodeReviewOnline/releases)
and upload it to your server's local gallery, then install it to a collection. Full walkthrough,
including how to remove it: [docs/installing.md](docs/installing.md).

## Building

```bash
npm ci
npm test           # 233 unit tests
dotnet build       # transpiles TypeScript, runs the tests, produces the .vsix
```

The `.vsix` lands in `src/TfvcCodeReviewOnline.Vsix/bin/<Configuration>/`. The packaging project runs
the tests first and fails on a red run, so a failing build cannot produce an installable package.

### Running the tests in Visual Studio's Test Explorer

`tests/TfvcCodeReviewOnline.Tests/TfvcCodeReviewOnline.Tests.esproj` exists purely to surface the
Vitest tests in Test Explorer. Visual Studio 2022 (17.12+) and Visual Studio 18 ship a first-party
Vitest adapter, so **no Visual Studio extension and no test adapter NuGet package are needed** — the
project builds nothing and just declares:

```xml
<JavaScriptTestRoot>unit\</JavaScriptTestRoot>
<JavaScriptTestFramework>Vitest</JavaScriptTestFramework>
```

Open the solution, build, and open **Test** > **Test Explorer**. If tests don't appear, rebuild —
discovery is build-triggered.

**It has to be an `.esproj`, not a `.csproj`.** Microsoft documents `JavaScriptTestFramework` for both
project types, but Vitest is only offered for `.esproj`; the ASP.NET Core (`.csproj`) walkthrough
lists Jest, Mocha, Tape, and Jasmine only. That is not merely a documentation gap: with a `.csproj`,
`JavascriptProjectTestDiscoverer` never engages at all, while with the `.esproj` it does.

Three rules the adapter imposes, all of which this repository already follows:

- **`vitest.config.ts` must live in the test project's folder.** The adapter creates its Vitest
  instance with `root` set to the folder containing the project file, so a config anywhere else is
  never read — and the tests would then run under Vitest's default `node` environment and fail on
  every DOM assertion. `npm test` points at the same root, so the command line, CI, and Test Explorer
  share one configuration.
- **Don't use `outFile` in a tsconfig that covers test files.** Test Explorer cannot find tests
  under it. The extension's own bundle does use `outFile`, but that is a separate tsconfig covering
  only `src/TfvcCodeReviewOnline.Web/ts`.
- **A `package.json` must sit in the test project's folder.** The JavaScript project system expects
  one there. It is a marker only — it declares no dependencies, because Node resolution walks up to
  the ones installed once at the repository root.

Layout:

| Path | What it is |
| --- | --- |
| `src/TfvcCodeReviewOnline.Web/ts/clients/discussionRestClient.ts` | Reads and parses the discussion threads |
| `src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient.ts` | Changed files and file content, over Microsoft's TFVC client |
| `src/TfvcCodeReviewOnline.Web/ts/model/` | Line diff, thread grouping, and line anchoring — no DOM, no platform |
| `src/TfvcCodeReviewOnline.Web/ts/view/` | Rendering, all of it through `textContent` |
| `src/TfvcCodeReviewOnline.Web/ts/platform/` | The only code that imports the Azure DevOps SDK |
| `scripts/*.ps1` | Export a review to HTML, add or remove the work item form tab, capture a test fixture, check for leaked environment references |
| `src/TfvcCodeReviewOnline.Vsix/` | Packaging project and `vss-extension.json` |
| `tests/TfvcCodeReviewOnline.Tests/` | Vitest tests, fixtures, and the Test Explorer container project |

## Roadmap

1. **Diagnostics tab** — done, and now replaced by the viewer below. It proved the read path against
   a real server, and the same job is done between the error panel and
   `scripts/Export-CodeReviewComments.ps1` when the contract needs re-checking after a server update.
2. **Read-only viewer** — done. File list with unresolved-thread counts, per-file diff of the shelved
   version against its base changeset, threads anchored inline at their line ranges with replies
   nested by `parentId`.
3. **Commenting** — done. Reply to any thread, comment on a whole file, or select lines in a diff
   and comment on them. This turned out to be plain REST on the same `discussion` area rather than
   the undocumented SOAP `PublishDiscussions` operation the design had assumed, so no SOAP transport
   was needed; see [docs/api-contract.md](docs/api-contract.md). Validated by confirming that a reply
   written here is indistinguishable from one written in Visual Studio.

4. **Closing a review** — done. **Close review** offers Visual Studio's own two choices, Complete and
   Abandon, and only while the review is open. It is the one thing the extension writes to the work
   item, and it goes through the work item form so the type's own rules apply; the rest of the
   closure — who closed it, when, the reason, the status code — is filled in by those rules. Closing
   asks for confirmation because the work item type defines no transition back out of `Closed`.

**Not planned: resolving threads.** The status field exists, but every thread on a TFVC review is
`active` — verified across 669 threads — because Visual Studio's code review page has no per-thread
resolve action. (Its per-file check box is a local, per-user marker, unrelated to thread state.)
Writing any other status would invent a state Visual Studio cannot display.

## A caveat worth stating plainly

The discussion route this reads is undocumented and unsupported. It has been stable across Azure
DevOps Server releases because it serves the same data Visual Studio's own Code Review page depends
on, but Microsoft makes no promise about it, and a future release could change or remove it. All
knowledge of its wire format is confined to `ts/clients/discussionRestClient.ts` and the fixture-based
tests over it, so a break is quick to find and fix — but treat this as a bridge for as long as your
team is on TFVC, not as a platform feature.

## License

[MIT](LICENSE)
