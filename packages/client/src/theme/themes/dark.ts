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
  'rgb-text-tertiary': '169 196 217',
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)

  // Ring colors
  'rgb-ring-primary': '137 207 240',

  // Header colors
  'rgb-header-primary': '13 32 61',
  'rgb-header-hover': '25 25 112',
  'rgb-header-button-hover': '25 25 112',

  // Surface colors
  'rgb-surface-active': '21 62 104',
  'rgb-surface-active-alt': '21 62 104',
  'rgb-surface-hover': '25 25 112',
  'rgb-surface-hover-alt': '21 62 104',
  'rgb-surface-primary': '13 32 61',
  'rgb-surface-primary-alt': '13 32 61',
  'rgb-surface-primary-contrast': '25 25 112',
  'rgb-surface-secondary': '25 25 112',
  'rgb-surface-secondary-alt': '25 25 112',
  'rgb-surface-tertiary': '21 62 104',
  'rgb-surface-tertiary-alt': '21 62 104',
  'rgb-surface-dialog': '13 32 61',
  'rgb-surface-submit': '137 207 240',
  'rgb-surface-submit-hover': '184 228 248',
  'rgb-surface-destructive': '153 27 27', // #991b1b (red-800)
  'rgb-surface-destructive-hover': '127 29 29', // #7f1d1d (red-900)
  'rgb-surface-chat': '13 32 61',

  // Border colors
  'rgb-border-light': '61 96 125',
  'rgb-border-medium': '61 96 125',
  'rgb-border-medium-alt': '61 96 125',
  'rgb-border-heavy': '93 131 160',
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
  'rgb-muted': '13 32 61',
  'rgb-muted-foreground': '192 192 192',
  'rgb-accent': '25 25 112',
  'rgb-accent-foreground': '254 254 255',
  'rgb-destructive-foreground': '254 254 255',
  'rgb-border': '61 96 125',
  'rgb-input': '61 96 125',
  'rgb-ring': '137 207 240',
  'rgb-card': '13 32 61',
  'rgb-card-foreground': '254 254 255',
};
