// Paths a document writes (its bibliography, its images, its links) are relative to the
// document. The workspace's files are named from the workspace's top. The kernel resolves
// them, for the host (which writes them again when files move, 0107) as for the page.
export { workspacePath } from '@kuraa/kernel';
