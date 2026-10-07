import type { CSSProperties } from 'react';

const logoMask = 'url(assets/logo.svg?v=4)';

const containerStyle: CSSProperties = {
  display: 'flex',
  padding: 4,
};

const logoStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  color: 'var(--text-primary)',
  backgroundColor: 'currentColor',
  maskImage: logoMask,
  WebkitMaskImage: logoMask,
  maskPosition: 'center',
  maskRepeat: 'no-repeat',
  maskSize: 'contain',
};

function Logo({ className, label }: { className: string; label: string }) {
  return (
    <div role="img" aria-label={label} className={className} style={containerStyle}>
      <div aria-hidden="true" style={logoStyle} />
    </div>
  );
}

export default Logo;
