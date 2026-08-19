import { BodyFrame } from '@/components/reader/BodyFrame';

export function DocxPreview({ html }: { html: string }) {
  return (
    <div className="h-full p-stack-gap-md">
      <BodyFrame html={html} text={null} heightConstrained />
    </div>
  );
}
