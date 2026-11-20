// The desktop launcher's icon (desktop/icon.svg), drawn inline so it needs no image request.
export function StudioLogo({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="64 64 896 896" role="img" aria-label="Collab Studio" className="studio-logo-svg">
    <defs><linearGradient id="studio-logo-base" x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#192234" /><stop offset="1" stopColor="#0b0e14" /></linearGradient></defs>
    <rect x="64" y="64" width="896" height="896" rx="208" fill="url(#studio-logo-base)" stroke="#4b5b79" strokeOpacity=".6" strokeWidth="3" />
    <circle cx="512" cy="512" r="268" fill="none" stroke="#82aaff" strokeOpacity=".1" strokeWidth="3" />
    <g fill="none" strokeLinecap="round">
      <path d="M512 512V258" stroke="#7ee2b8" strokeOpacity=".2" strokeWidth="40" /><path d="M512 512 288 642" stroke="#82aaff" strokeOpacity=".2" strokeWidth="40" /><path d="M512 512 736 642" stroke="#c792ea" strokeOpacity=".2" strokeWidth="40" />
      <path d="M512 512V258" stroke="#7ee2b8" strokeWidth="15" /><path d="M512 512 288 642" stroke="#82aaff" strokeWidth="15" /><path d="M512 512 736 642" stroke="#c792ea" strokeWidth="15" />
    </g>
    <g fill="#151d2b" strokeWidth="11"><rect x="464" y="210" width="96" height="96" rx="30" stroke="#7ee2b8" /><rect x="240" y="594" width="96" height="96" rx="30" stroke="#82aaff" /><rect x="688" y="594" width="96" height="96" rx="30" stroke="#c792ea" /></g>
    <circle cx="512" cy="258" r="12" fill="#7ee2b8" /><circle cx="288" cy="642" r="12" fill="#82aaff" /><circle cx="736" cy="642" r="12" fill="#c792ea" />
    <rect x="423" y="423" width="178" height="178" rx="52" fill="#0f1722" stroke="#7ee2b8" strokeWidth="12" />
    <g fill="#7ee2b8"><circle cx="478" cy="512" r="7" /><circle cx="512" cy="512" r="7" /><circle cx="546" cy="512" r="7" /></g>
  </svg>;
}
