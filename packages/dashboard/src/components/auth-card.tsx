import type { FormEventHandler, ReactNode } from "react";

/**
 * The unauthenticated screens: a centred 420px column on `Background L2`.
 *
 * No card and no wordmark — the design puts the heading and the fields straight
 * on the background. The 27px gap between the heading block and the field group,
 * and the 16px gap between fields, are both from the file.
 */
export function AuthCard({
  title,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background-l2 px-[16px]">
      <div className="flex w-[420px] max-w-full flex-col gap-[27px]">
        <div className="flex w-full flex-col items-center">
          <h1 className="type-heading-20 w-full text-center text-foreground-primary">{title}</h1>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex w-full flex-col gap-[16px]">
          {children}
        </form>

        {footer !== undefined ? (
          <p className="type-label-12 text-center text-foreground-secondary">{footer}</p>
        ) : null}
      </div>
    </div>
  );
}
