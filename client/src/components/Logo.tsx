import type { CSSProperties } from 'react';

const logoMask = 'url(assets/logo.svg?v=4)';
const compactLogoMask = 'url(assets/logo_small.svg?v=4)';

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

const compactLogoStyle: CSSProperties = {
  ...logoStyle,
  maskImage: compactLogoMask,
  WebkitMaskImage: compactLogoMask,
};

function Logo({
  className,
  label,
  compact = false,
}: {
  className: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <div role="img" aria-label={label} className={className} style={containerStyle}>
      <div aria-hidden="true" style={compact ? compactLogoStyle : logoStyle} />
    </div>
  );
}

export default Logo;
