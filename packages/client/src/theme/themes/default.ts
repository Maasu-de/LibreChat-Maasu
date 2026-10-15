import { IThemeRGB } from '../types';

/**
 * Default light theme
 * AIMO brand palette, kept in sync with client/src/style.css
 */
export const defaultTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '1 0 1',
  'rgb-text-secondary': '61 96 125',
  'rgb-text-secondary-alt': '82 109 135',
  'rgb-text-tertiary': '82 109 135',
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)

  // Ring colors
  'rgb-ring-primary': '1 21 233',

  // Header colors
  'rgb-header-primary': '254 254 255',
  'rgb-header-hover': '245 248 255',
  'rgb-header-button-hover': '245 248 255',

  // Surface colors
  'rgb-surface-active': '234 245 252',
  'rgb-surface-active-alt': '214 235 250',
  'rgb-surface-hover': '234 245 252',
  'rgb-surface-hover-alt': '214 235 250',
  'rgb-surface-primary': '254 254 255',
  'rgb-surface-primary-alt': '245 248 255',
  'rgb-surface-primary-contrast': '234 245 252',
  'rgb-surface-secondary': '245 248 255',
  'rgb-surface-secondary-alt': '217 225 238',
  'rgb-surface-tertiary': '234 245 252',
  'rgb-surface-tertiary-alt': '254 254 255',
  'rgb-surface-dialog': '254 254 255',
  'rgb-surface-submit': '1 21 233',
  'rgb-surface-submit-hover': '25 25 112',
  'rgb-surface-destructive': '185 28 28', // #b91c1c (red-700)
  'rgb-surface-destructive-hover': '153 27 27', // #991b1b (red-800)
  'rgb-surface-chat': '254 254 255',

  // Border colors
  'rgb-border-light': '217 225 238',
  'rgb-border-medium': '192 192 192',
  'rgb-border-medium-alt': '192 192 192',
  'rgb-border-heavy': '138 158 174',
  'rgb-border-xheavy': '82 109 135',

  // Brand colors
  'rgb-brand-purple': '1 21 233',

  // Presentation
  'rgb-presentation': '254 254 255',

  // Utility colors (mapped to existing colors for backwards compatibility)
  'rgb-background': '254 254 255',
  'rgb-foreground': '1 0 1',
  'rgb-primary': '1 21 233',
  'rgb-primary-foreground': '254 254 255',
  'rgb-secondary': '245 248 255',
  'rgb-secondary-foreground': '1 0 1',
  'rgb-muted': '234 245 252',
  'rgb-muted-foreground': '82 109 135',
  'rgb-accent': '234 245 252',
  'rgb-accent-foreground': '1 0 1',
  'rgb-destructive-foreground': '254 254 255',
  'rgb-border': '192 192 192',
  'rgb-input': '192 192 192',
  'rgb-ring': '1 21 233',
  'rgb-card': '254 254 255',
  'rgb-card-foreground': '1 0 1',
};
