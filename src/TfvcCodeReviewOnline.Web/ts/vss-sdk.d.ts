// Pulls in the ambient declarations for the classic Azure DevOps / TFS web extension SDK: the global
// `VSS` object and the platform's AMD modules ("TFS/...", "VSS/..."). Kept inside ts/ so both the
// AMD build and the repository-wide type check pick it up without either config having to reach into
// node_modules by path.
/// <reference types="vss-web-extension-sdk" />
