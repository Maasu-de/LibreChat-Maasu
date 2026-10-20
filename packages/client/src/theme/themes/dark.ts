import { IThemeRGB } from '../types';

/**
 * Dark theme
 * AIMO dark palette, kept in sync with client/src/style.css
 */
export const darkTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '245 245 247',
  'rgb-text-secondary': '161 161 166',
  'rgb-text-secondary-alt': '161 161 166',
  'rgb-text-tertiary': '134 134 139',
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)

  // Ring colors
  'rgb-ring-primary': '0 113 227',

  // Header colors
  'rgb-header-primary': '0 0 0',
  'rgb-header-hover': '29 29 31',
  'rgb-header-button-hover': '29 29 31',

  // Surface colors
  'rgb-surface-active': '29 29 31',
  'rgb-surface-active-alt': '42 42 44',
  'rgb-surface-hover': '29 29 31',
  'rgb-surface-hover-alt': '42 42 44',
  'rgb-surface-primary': '0 0 0',
  'rgb-surface-primary-alt': '0 0 0',
  'rgb-surface-primary-contrast': '29 29 31',
  'rgb-surface-secondary': '29 29 31',
  'rgb-surface-secondary-alt': '42 42 44',
  'rgb-surface-tertiary': '29 29 31',
  'rgb-surface-tertiary-alt': '42 42 44',
  'rgb-surface-dialog': '29 29 31',
  'rgb-surface-submit': '0 102 204',
  'rgb-surface-submit-hover': '0 113 227',
  'rgb-surface-destructive': '224 48 62',
  'rgb-surface-destructive-hover': '179 0 27',
  'rgb-surface-chat': '29 29 31',

  // Border colors
  'rgb-border-light': '44 44 46',
  'rgb-border-medium': '58 58 60',
  'rgb-border-medium-alt': '58 58 60',
  'rgb-border-heavy': '72 72 74',
  'rgb-border-xheavy': '110 110 115',

  // Brand colors
  'rgb-brand-purple': '0 113 227',

  // Presentation
  'rgb-presentation': '0 0 0',

  // Utility colors (mapped to existing colors for backwards compatibility)
  'rgb-background': '0 0 0',
  'rgb-foreground': '245 245 247',
  'rgb-primary': '0 102 204',
  'rgb-primary-foreground': '255 255 255',
  'rgb-secondary': '29 29 31',
  'rgb-secondary-foreground': '245 245 247',
  'rgb-muted': '29 29 31',
  'rgb-muted-foreground': '161 161 166',
  'rgb-accent': '29 29 31',
  'rgb-accent-foreground': '245 245 247',
  'rgb-destructive-foreground': '255 255 255',
  'rgb-border': '58 58 60',
  'rgb-input': '58 58 60',
  'rgb-ring': '0 113 227',
  'rgb-card': '29 29 31',
  'rgb-card-foreground': '245 245 247',
};
