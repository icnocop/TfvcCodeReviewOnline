# Installing, and removing

## Azure DevOps Server (on-premises)

On-premises servers have a local extension gallery, so no internet access and no Marketplace account
are needed.

1. Get a `.vsix`, either from the [releases page](https://github.com/icnocop/TfvcCodeReviewOnline/releases)
   or by building the repository (`npm ci` then `dotnet build`; the package lands in
   `src/TfvcCodeReviewOnline.Vsix/bin/<Configuration>/`).
2. Browse to `http://<your-server>/_gallery/manage`.
3. Choose **Upload new extension** and select the `.vsix`.
4. Once it appears in the list, select it and choose **Install**, then pick the collection to install
   it into. **Uploading alone is not enough** — it only publishes the extension to the local gallery.
   Until you complete this step, nothing appears anywhere.
5. Add the tab to the work item type. See below; on-premises servers need this and it is easy to
   miss.

You need collection- or server-level administrator rights to upload and install.

### Adding the tab to the Code Review Request form (on-premises XML process model)

On-premises collections use the XML process model, where a work item form extension appears **only if
the work item type definition asks for it**. Installing the extension is not sufficient: without this
step the extension is installed and working, and no tab is visible.

Use the script, which does the whole round trip:

```powershell
# See exactly what would change, and schema-validate it, without importing anything.
.\scripts\Set-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject" -WhatIf

# Apply it.
.\scripts\Set-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject"
```

It locates `witadmin.exe`, exports the definition, writes a timestamped backup, makes the edit,
validates the result with `witadmin importwitd /v`, and imports only after confirming. It is
idempotent, so running it twice changes nothing the second time. Pass `-Remove` to revert.

Work item type definitions are per-project, so run it once per team project whose reviews should
show the tab. Add `-WorkItemTypeName` if your reviews use a differently named type.

<details>
<summary>Doing it by hand instead</summary>

```cmd
witadmin exportwitd /collection:http://<your-server>/<collection> /p:"<project>" /n:"Code Review Request" /f:CodeReviewRequest.xml
witadmin importwitd /collection:http://<your-server>/<collection> /p:"<project>" /f:CodeReviewRequest.xml
```

`witadmin.exe` lives in the Visual Studio Team Explorer folder, for example
`…\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\witadmin.exe`.

Inside `<WebLayout>`, add two elements. **`<Extensions>` must be the first child, ahead of
`<SystemControls>`.** The documentation only says to place it "prior to a `Page` element", but the
schema is stricter: putting it after `<SystemControls>` is rejected with *"The element 'WebLayout'
has invalid child element 'Extensions'. List of possible elements expected: 'Page,
PageContribution'."*

```xml
<WebLayout>
  <Extensions>
    <Extension Id="icnocop.tfvc-code-review-online" />
  </Extensions>

  <SystemControls>
    ...
  </SystemControls>

  <Page Label="Details" LayoutMode="FirstColumnWide">
    ...
  </Page>

  <PageContribution Id="icnocop.tfvc-code-review-online.code-review-comments" Label="Comments" />
</WebLayout>
```

Validate before importing with `witadmin importwitd … /v`, and **read its output rather than its
exit code** — witadmin returns 0 even when validation fails.

`Extension Id` is `<publisher>.<extension-id>`; `PageContribution Id` appends the contribution ID
declared in `vss-extension.json`. Both must match the extension as installed, and the extension must
already be installed on the collection or the import will be rejected.

</details>

## Azure DevOps Services

Publish it to the Marketplace as a private extension under your own publisher and share it with your
organization:

```bash
npx tfx extension publish --vsix <file>.vsix --publisher <your-publisher> --share-with <your-org>
```

The manifest sets `"public": false`, so it stays private until you change that deliberately.

## Signing in

The first time you open the **Comments** tab, it asks for a personal access token. That is unusual
for an extension, so it is worth explaining.

Azure DevOps Server refuses an extension's own delegated token at the discussion API, while accepting
a personal access token for the identical request. There is no scope that changes this: `vso.threads_full`
and `user_impersonation` do not exist on Server 2019, and every scope that does exist is still
refused. So the tab uses your token, stored against your own account and not visible to anyone else
using the extension.

Create one from **User settings > Personal access tokens** with read access to **Work Items** and
**Code**, and nothing more. Set an expiry you are comfortable with; the tab asks again when it lapses.

The section below removes this requirement entirely, at a cost.

## Optional: patching Azure DevOps so no token is needed

Azure DevOps renders extension content in a sandboxed iframe **without** `allow-same-origin`. That
gives the frame an opaque origin, so every request it makes is cross-origin even against its own
server, cookies cannot be sent, and Windows authentication never applies. Adding `allow-same-origin`
makes the frame same-origin, CORS stops applying, and the tab authenticates as the signed-in user
with no token at all.

> **This edits a file Microsoft ships, and it is not supported.** Weigh it properly:
>
> - **It must be redone after every server update or patch.** The bundle name contains a hash of its
>   content, and its contents change between versions. Worse, if you leave the rewrite rule in place
>   across an upgrade it will serve the *old* bundle against the *new* server, which breaks the web
>   UI. Remove the rule before updating, then redo the patch afterwards.
> - **It weakens isolation for every extension on the server**, not just this one. That sandbox
>   attribute is the boundary preventing any installed extension from acting against the signed-in
>   user's session. On a server running a handful of extensions you trust, that may be an acceptable
>   trade; it is still a real one.
>
> If neither is acceptable, use a personal access token. It is contained to this extension, needs no
> server changes, and survives upgrades.

### Using the script

Copy `scripts/Set-ExtensionFrameSameOrigin.ps1` to the application tier and run it there from an
elevated prompt:

```powershell
# See what would change, without touching anything.
.\Set-ExtensionFrameSameOrigin.ps1 -WhatIf

# Apply it.
.\Set-ExtensionFrameSameOrigin.ps1

# Restart IIS so the regenerated bundle is served, then hard-refresh the browser.
iisreset
```

It finds the installation, backs up each file before editing, is idempotent, and takes `-Revert`.
It deliberately does not restart IIS itself — taking the site down is your call, not the script's.

### What it edits, and why there is nothing to copy

The sandbox attribute is set in exactly one shipped module, present in both a minified and a debug
flavor:

```
<install>\Application Tier\Web Services\_static\tfs\<version>\_scripts\TFS\min\VSS\Contributions\Controls.js
<install>\Application Tier\Web Services\_static\tfs\<version>\_scripts\TFS\debug\VSS\Contributions\Controls.js
```

The `vss-bundle-common` bundle that the browser downloads is generated from those files, so editing
them in place is enough. Nothing needs copying into `inetpub`, and no URL rewrite rule is required.

The assignment reads (minified flavor; the debug flavor uses single quotes and a space after the
comma, which is why the script matches both):

```js
this._$iframe.attr("sandbox","allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts allow-top-navigation")
```

and the script appends ` allow-same-origin` to that list, editing only the attribute value.

Verified against Azure DevOps Server 2019 Update 1 (`Dev17.M153.6`). The surrounding code differs
between versions; the script anchors on the attribute rather than on any particular formatting, and
warns rather than guessing if it cannot find it.

### Verifying

Hard-refresh a work item and open the **Comments** tab. If the patch is live, the threads load
without asking for a token. If it still asks, the browser is probably serving the previous bundle
from cache.

To confirm directly, open developer tools, select the extension's iframe, and check that its
`sandbox` attribute now includes `allow-same-origin`.

### Reverting

```powershell
.\Set-ExtensionFrameSameOrigin.ps1 -Revert
iisreset
```

Each run also leaves a timestamped `.backup` copy of the original beside the file, so the shipped
version can be restored by hand if needed. After reverting, the extension falls straight back to
asking for a personal access token, and any token already stored keeps working.

### After a server update

An update replaces these files, so the change is lost and the token prompt returns. Re-run the
script. This is why it edits the shipped files rather than adding a URL rewrite rule: a stale rewrite
rule would survive the upgrade and keep serving outdated script against a newer server, which breaks
the web UI in ways that are hard to trace.

## Using it

Open any **Code Review Request** work item — from the work item list, a query, or a direct URL such
as `http://<your-server>/<collection>/<project>/_workitems/edit/1234` — and select the **Comments**
tab.

On a work item that is not a code review request, the tab shows a short empty state and does nothing
else.

## Removing it

**Uninstalling or disabling the extension is the kill switch, and it is complete.** Go to
`http://<your-server>/_gallery/manage`, select the extension, and choose **Disable** or
**Uninstall**. Either one returns the site to exactly the behavior it had before.

On an on-premises server, **revert the work item type definition change first, before uninstalling
the extension**:

```powershell
.\scripts\Remove-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject"
```

(`Set-WorkItemFormExtension.ps1 -Remove` does the same thing; the two share one implementation.)

### Why the order matters

A work item type definition that references an extension which is not installed **cannot be
imported**. witadmin rejects it:

```
VS403121: Extension(s) "icnocop.tfvc-code-review-online" does not exist, or has no work item form
contribution.
```

So if you uninstall the extension and leave the reference behind, the definition on the server keeps
working — the form still loads and the orphaned tab simply does not render — but that work item type
becomes **read-only to `witadmin`**. The next person to change anything about it, for a reason that
has nothing to do with this extension, hits `VS403121` and has to work out why. Their export will
contain the stale `<Extension>` and `<PageContribution>` entries, and the import will keep failing
until those are deleted.

It is recoverable at any time — export, delete the two elements, import — but it is a confusing trap
to leave for somebody else. Removing the reference before uninstalling avoids it entirely.

If you have already uninstalled the extension, run the removal script anyway: it only edits and
re-imports the definition, and does not need the extension to be present.

Beyond that, nothing is left behind:

- The extension writes to a work item in exactly one case: when someone uses **Close review** and
  confirms it. That sets `System.State` to `Closed` and `Microsoft.VSTS.CodeReview.ClosedStatus` to
  `Checked-in` or `Abandoned`, through the work item form, which is the same revision the person
  would have saved by hand. Nothing else on the form is touched, and nothing is written on load.
- Note that closing a review **cannot be undone from any client** — the work item type defines no
  transition out of `Closed`. That is a property of the process template, not of this extension, and
  it is why the tab asks for confirmation first.
- No data is stored anywhere. Everything displayed is fetched per page load from the collection.

## If the tab shows an error

The tab renders failures in place, with the message and the raw service response, rather than showing
an empty panel — so the error text is usually enough to tell what happened. The surrounding work item
form is unaffected either way, because Azure DevOps hosts every extension contribution in its own
frame.

To confirm the same thing outside the browser, run the standalone exporter against the same review:

```powershell
.\scripts\Export-CodeReviewComments.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234
```

- **It works, but the tab does not** — the problem is in the extension or in how the browser reaches
  the service, not in the service or your permissions.
- **It fails the same way** — the problem is the service, the review, or your permissions. If it
  fails after a server upgrade, re-run `scripts/Get-DiscussionWsdl.ps1` and check `git diff schema/`:
  a changed contract means the service moved. See [api-contract.md](api-contract.md).
