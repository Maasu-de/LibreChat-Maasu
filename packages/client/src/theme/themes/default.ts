import { IThemeRGB } from '../types';

/**
 * Default light theme
 * AIMO v2 palette, kept in sync with client/src/style.css
 */
export const defaultTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '29 29 31',
  'rgb-text-secondary': '110 110 115',
  'rgb-text-secondary-alt': '110 110 115',
  'rgb-text-tertiary': '134 134 139',
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)

  // Ring colors
  'rgb-ring-primary': '0 113 227',

  // Header colors
  'rgb-header-primary': '255 255 255',
  'rgb-header-hover': '245 245 247',
  'rgb-header-button-hover': '245 245 247',

  // Surface colors
  'rgb-surface-active': '245 245 247',
  'rgb-surface-active-alt': '236 236 238',
  'rgb-surface-hover': '245 245 247',
  'rgb-surface-hover-alt': '236 236 238',
  'rgb-surface-primary': '255 255 255',
  'rgb-surface-primary-alt': '245 245 247',
  'rgb-surface-primary-contrast': '245 245 247',
  'rgb-surface-secondary': '245 245 247',
  'rgb-surface-secondary-alt': '224 224 224',
  'rgb-surface-tertiary': '245 245 247',
  'rgb-surface-tertiary-alt': '255 255 255',
  'rgb-surface-dialog': '255 255 255',
  'rgb-surface-submit': '0 102 204',
  'rgb-surface-submit-hover': '0 113 227',
  'rgb-surface-destructive': '224 48 62',
  'rgb-surface-destructive-hover': '179 0 27',
  'rgb-surface-chat': '255 255 255',

  // Border colors
  'rgb-border-light': '235 235 235',
  'rgb-border-medium': '224 224 224',
  'rgb-border-medium-alt': '224 224 224',
  'rgb-border-heavy': '210 210 215',
  'rgb-border-xheavy': '161 161 166',

  // Brand colors
  'rgb-brand-purple': '0 102 204',

  // Presentation
  'rgb-presentation': '255 255 255',

  // Utility colors (mapped to existing colors for backwards compatibility)
  'rgb-background': '255 255 255',
  'rgb-foreground': '29 29 31',
  'rgb-primary': '0 102 204',
  'rgb-primary-foreground': '255 255 255',
  'rgb-secondary': '245 245 247',
  'rgb-secondary-foreground': '29 29 31',
  'rgb-muted': '245 245 247',
  'rgb-muted-foreground': '110 110 115',
  'rgb-accent': '245 245 247',
  'rgb-accent-foreground': '29 29 31',
  'rgb-destructive-foreground': '255 255 255',
  'rgb-border': '224 224 224',
  'rgb-input': '224 224 224',
  'rgb-ring': '0 113 227',
  'rgb-card': '255 255 255',
  'rgb-card-foreground': '29 29 31',
};
