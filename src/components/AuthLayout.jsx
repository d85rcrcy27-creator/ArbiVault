import React from 'react'

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <main className="min-h-[100dvh] flex items-center justify-center bg-background px-3 py-4 sm:px-6 sm:py-8 [padding-top:max(1rem,env(safe-area-inset-top))] [padding-bottom:max(1rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center sm:mb-8">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary sm:h-14 sm:w-14">
            <Icon className="h-6 w-6 text-primary-foreground sm:h-7 sm:w-7" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
          {subtitle && <p className="mx-auto mt-2 max-w-md px-2 text-sm leading-5 text-muted-foreground sm:text-base">{subtitle}</p>}
        </div>
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
          {children}
        </section>
        {footer && <p className="px-2 pt-4 text-center text-sm leading-5 text-muted-foreground sm:pt-6">{footer}</p>}
      </div>
    </main>
  )
}
