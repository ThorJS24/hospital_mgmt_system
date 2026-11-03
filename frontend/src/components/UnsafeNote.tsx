/** Renders patient clinical notes as escaped text. */
export function ClinicalNote({ text }: { text: string }) {
  if (!text) return <span className="text-muted">No notes recorded.</span>;
  return <p className="whitespace-pre-wrap">{text}</p>;
}
