import type { ReactNode } from "react";
import { ProductBrand, type ProductName } from "./ProductIdentity";
import "../saas-login.css";

export type SaasLoginFrameProps = {
  product: ProductName;
  title: string;
  description: string;
  children: ReactNode;
};

const PRODUCT_INTRO: Record<ProductName, { label: string; heading: string; description: string }> = {
  fireflint: {
    label: "Content-Arbeitsplatz",
    heading: "Content klar organisiert.",
    description: "Pflege Website-Inhalte zentral, prüfe Änderungen und veröffentliche bewusst.",
  },
  koiforge: {
    label: "Datenanalyse",
    heading: "Daten verständlich analysieren.",
    description: "Erkunde deine Daten und erkenne Zusammenhänge in einer klar strukturierten Arbeitsfläche.",
  },
};

export function SaasLoginFrame({ product, title, description, children }: SaasLoginFrameProps) {
  const intro = PRODUCT_INTRO[product];

  return <main className={`nf-auth-screen nf-auth-screen--${product}`}>
    <div className="nf-auth-frame">
      <section className={`nf-auth-brand-panel nf-auth-brand-panel--${product}`} aria-label={intro.label}>
        <div className={`nf-auth-brand nf-auth-brand--${product}`}>
          <ProductBrand product={product} />
        </div>
        <div className="nf-auth-intro">
          <p className="nf-auth-product-label">{intro.label}</p>
          <h2>{intro.heading}</h2>
          <p>{intro.description}</p>
        </div>
      </section>

      <section className="nf-auth-form-panel" aria-label={title}>
        <div className="nf-auth-form-content">
          <h1>{title}</h1>
          <p className="nf-auth-description">{description}</p>
          <div className="nf-auth-form-slot">{children}</div>
        </div>
      </section>
    </div>
  </main>;
}
