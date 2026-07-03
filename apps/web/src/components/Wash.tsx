/**
 * Fixed full-viewport wallpaper wash: warm-white gradient with three large
 * blurred color blobs (pure CSS radial-gradients — no images).
 */
export function Wash() {
  return (
    <div className="wash" aria-hidden="true">
      <div className="wash-blob wash-blob-1" />
      <div className="wash-blob wash-blob-2" />
      <div className="wash-blob wash-blob-3" />
    </div>
  );
}
