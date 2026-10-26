import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { ClassProp } from 'class-variance-authority/types';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/utils';

const buttonVariants: (
  props?:
    | ({
        variant?:
          | 'default'
          | 'link'
          | 'submit'
          | 'outline'
          | 'destructive'
          | 'secondary'
          | 'ghost'
          | null
          | undefined;
        size?: 'default' | 'icon' | 'sm' | 'lg' | null | undefined;
      } & ClassProp)
    | undefined,
) => string = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[-0.016em] active:scale-[0.97] motion-reduce:active:scale-100 ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-aimo-blue-hover',
        destructive:
          'bg-surface-destructive text-destructive-foreground hover:bg-surface-destructive-hover',
        outline:
          'text-text-primary border border-aimo-line bg-transparent hover:border-aimo-blue hover:bg-aimo-blue-soft hover:text-aimo-blue dark:hover:text-white',
        secondary:
          'border border-border-medium bg-surface-primary text-text-primary hover:border-ring-primary hover:bg-surface-hover',
        ghost: 'hover:bg-surface-hover hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        submit:
          'bg-surface-submit text-[color:var(--surface-submit-ink,#fefeff)] hover:bg-surface-submit-hover',
      },
      size: {
        default: 'h-[38px] px-[18px] py-2',
        sm: 'h-9 px-3',
        lg: 'h-12 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button: React.ForwardRefExoticComponent<
  ButtonProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
