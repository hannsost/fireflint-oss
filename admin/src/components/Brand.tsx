import { ProductBrand, ProductMark, UiIcon } from "./ProductIdentity";

export function FireFlintMark({ className = "" }: { className?: string }) {
  return <ProductMark product="fireflint" className={`fireflint-mark ${className}`} />;
}

export function FireFlintBrand() {
  return <ProductBrand product="fireflint" />;
}

export { UiIcon };
export type { IconName } from "./ProductIdentity";
