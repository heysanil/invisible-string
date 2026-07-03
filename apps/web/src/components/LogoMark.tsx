export interface LogoMarkProps {
  size?: number;
}

/** Ink triangle mark — soft corners via a round-joined stroke. */
export function LogoMark({ size = 20 }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 4.2 20.6 19.8H3.4Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}
