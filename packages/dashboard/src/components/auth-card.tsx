import type { FormEventHandler, ReactNode } from "react";

/**
 * The centred card the two unauthenticated screens share.
 *
 * Sign-in and first-run setup are the same object with different copy, and
 * keeping them one component is what stops the pair from drifting apart the
 * first time either is touched.
 */
export function AuthCard({
  title,
  subtitle,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-l1 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-1.5 text-center">
          <span className="text-sm font-semibold tracking-tight text-foreground-primary">
            omni-model
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground-primary">{title}</h1>
          {subtitle !== undefined ? (
            <p className="text-sm text-foreground-secondary">{subtitle}</p>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="panel flex flex-col gap-4 px-5 py-5">
          {children}
        </form>

        {footer !== undefined ? (
          <div className="mt-4 text-center text-xs text-foreground-secondary">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
