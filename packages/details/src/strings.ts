// Document details' words.

export const S = {
  panel: 'Details',
  synopsis: 'Synopsis',
  synopsisPlaceholder: 'What happens here, in a sentence or two',
  label: 'Label',
  labelPlaceholder: 'Chapter, Scene, Notes…',
  status: 'Status',
  noStatus: 'No status',
  keywords: 'Keywords',
  keywordsPlaceholder: 'Separated by commas',
  about: 'Kept in the document’s header (synopsis, label, status, keywords), for everyone who opens it. A label’s colour shows by the document in the file tree.',
  noDocument: 'Open a document to see its details.',
  noHeader: 'This kind of document has no header to keep details in.',
  mark: (label: string | null, status: string | null) => [label && `Label: ${label}`, status && `Status: ${status}`].filter(Boolean).join(' · '),
  statusesSetting: 'Statuses',
  statusesAbout: 'The statuses offered for documents, separated by commas. Empty: To do, First draft, Revised draft, Final draft, Done.',
};
