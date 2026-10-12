import { IThemeRGB } from '../types';

/**
 * Dark theme
 * AIMO dark palette, kept in sync with client/src/style.css
 */
export const darkTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '254 254 255',
  'rgb-text-secondary': '192 192 192',
  'rgb-text-secondary-alt': '192 192 192',
  'rgb-text-tertiary': '174 182 209',
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)

  // Ring colors
  'rgb-ring-primary': '137 207 240',

  // Header colors
  'rgb-header-primary': '16 19 39',
  'rgb-header-hover': '25 25 112',
  'rgb-header-button-hover': '25 25 112',

  // Surface colors
  'rgb-surface-active': '38 43 104',
  'rgb-surface-active-alt': '38 43 104',
  'rgb-surface-hover': '25 25 112',
  'rgb-surface-hover-alt': '38 43 104',
  'rgb-surface-primary': '16 19 39',
  'rgb-surface-primary-alt': '16 19 39',
  'rgb-surface-primary-contrast': '25 25 112',
  'rgb-surface-secondary': '25 25 112',
  'rgb-surface-secondary-alt': '25 25 112',
  'rgb-surface-tertiary': '38 43 104',
  'rgb-surface-tertiary-alt': '38 43 104',
  'rgb-surface-dialog': '16 19 39',
  'rgb-surface-submit': '137 207 240',
  'rgb-surface-submit-hover': '184 228 248',
  'rgb-surface-destructive': '153 27 27', // #991b1b (red-800)
  'rgb-surface-destructive-hover': '127 29 29', // #7f1d1d (red-900)
  'rgb-surface-chat': '16 19 39',

  // Border colors
  'rgb-border-light': '65 69 110',
  'rgb-border-medium': '65 69 110',
  'rgb-border-medium-alt': '65 69 110',
  'rgb-border-heavy': '102 107 144',
  'rgb-border-xheavy': '138 143 158',

  // Brand colors
  'rgb-brand-purple': '137 207 240',

  // Presentation
  'rgb-presentation': '1 0 1',

  // Utility colors (mapped to existing colors for backwards compatibility)
  'rgb-background': '1 0 1',
  'rgb-foreground': '254 254 255',
  'rgb-primary': '137 207 240',
  'rgb-primary-foreground': '1 0 1',
  'rgb-secondary': '25 25 112',
  'rgb-secondary-foreground': '254 254 255',
  'rgb-muted': '16 19 39',
  'rgb-muted-foreground': '192 192 192',
  'rgb-accent': '25 25 112',
  'rgb-accent-foreground': '254 254 255',
  'rgb-destructive-foreground': '254 254 255',
  'rgb-border': '65 69 110',
  'rgb-input': '65 69 110',
  'rgb-ring': '137 207 240',
  'rgb-card': '16 19 39',
  'rgb-card-foreground': '254 254 255',
};
