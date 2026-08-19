export function TextPreview({ text }: { text: string }) {
  return (
    <pre className="h-full select-text overflow-auto whitespace-pre-wrap break-words p-stack-gap-md font-mono text-body-sm text-on-surface dark:text-dark-on-surface">
      {text}
    </pre>
  );
}
