import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BadgeCheck,
  Box,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  FileText,
  GitBranch,
  Globe,
  Hammer,
  Image,
  Info,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Store,
  Trash2,
  TriangleAlert,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

export type ProductName = "fireflint" | "koiforge";

export type IconName =
  | "overview" | "content" | "website" | "media" | "team" | "spark" | "key" | "activity" | "settings"
  | "arrow" | "external" | "chevron" | "close" | "plus" | "trash" | "check" | "menu" | "search"
  | "back" | "up" | "down" | "source" | "diagram" | "workflow" | "quality" | "box" | "network" | "lineage" | "board" | "store"
  | "workshop" | "help" | "warning" | "info" | "logout";

const iconByName: Record<IconName, LucideIcon> = {
  overview: LayoutDashboard,
  content: FileText,
  website: Globe,
  media: Image,
  team: Users,
  spark: Sparkles,
  key: KeyRound,
  activity: Activity,
  settings: SlidersHorizontal,
  arrow: ArrowRight,
  back: ArrowLeft,
  up: ArrowUp,
  down: ArrowDown,
  external: ArrowUpRight,
  chevron: ChevronDown,
  close: X,
  plus: Plus,
  trash: Trash2,
  check: Check,
  menu: Menu,
  search: Search,
  source: Database,
  diagram: ChartNoAxesCombined,
  workflow: Workflow,
  quality: BadgeCheck,
  box: Box,
  network: Network,
  lineage: GitBranch,
  board: LayoutDashboard,
  store: Store,
  workshop: Hammer,
  help: CircleHelp,
  warning: TriangleAlert,
  info: Info,
  logout: LogOut,
};

export function ProductMark({ product, className = "" }: { product: ProductName; className?: string }) {
  if (product === "fireflint") {
    return <svg className={`nf-brand-symbol ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <g transform="translate(0 1.2) scale(1 .9)">
      <path d="M13 1c2 7 8 9 8 14a9 9 0 0 1-18 0c0-4 3-7 6-10-1 5 0 7 2 8 3-3 3-7 2-12Z"
        stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 14c-3 3-3 6 0 7 3-1 3-4 0-7Z" fill="currentColor" />
      </g>
    </svg>;
  }

  return <svg className={`nf-brand-symbol ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <g transform="translate(-1.33 -.47) scale(.86)" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round">
      <path d="M26 6C15 3 5 10 6 20c6 1 13-3 16-9M6 26c11 3 21-4 20-14-6-1-13 3-16 9" />
      <circle cx="10" cy="15" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="22" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </g>
  </svg>;
}

export function ProductBrand({ product }: { product: ProductName }) {
  const label = product === "fireflint" ? "FireFlint" : "KoiForge";
  return <span className={`nf-brand nf-brand--${product}`}>
    <ProductMark product={product} />
    <span className="nf-brand-copy">
      <span className="nf-brand-name">{label}</span>
      <span className="nf-brand-parent">von neurofunken</span>
    </span>
  </span>;
}

export function UiIcon({ name, className = "", size = 20 }: { name: IconName; className?: string; size?: number }) {
  const Icon = iconByName[name];
  return <Icon className={`nf-icon ${className}`} size={size} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" />;
}
