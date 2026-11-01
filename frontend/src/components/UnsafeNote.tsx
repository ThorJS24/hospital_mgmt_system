import { useAuth } from '../lib/auth';

/**
 * Renders patient clinical notes.
 * INTENTIONAL WEAKNESS (HMS-V02, lab mode only): when the backend reports `unsafeNotes`, the note is injected
 * as raw HTML. In every other configuration it is rendered as escaped text.
 */
export function ClinicalNote({ text }: { text: string }) {
  const { lab } = useAuth();
  if (!text) return <span className="text-muted">No notes recorded.</span>;
  if (lab.unsafeNotes) return <div className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: text }} />;
  return <p className="whitespace-pre-wrap">{text}</p>;
}
