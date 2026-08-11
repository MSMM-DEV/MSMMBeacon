import React from "react";
import {
  AlignLeft, ArrowLeft, ArrowRight, ArrowUpDown, Ban, Bell, BellRing, Blocks, Bookmark,
  Braces, Briefcase, Building2, Calendar, CalendarClock, CalendarDays, ChartColumn,
  Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  ChevronsLeft, ChevronsRight, ChevronsUpDown, CircleDot, CircleHelp, ClipboardList, Clock,
  Columns3, Copy, CreditCard, Download, Ellipsis, ExternalLink, Eye, EyeOff, File, FileText,
  Files, Filter, Flag, FolderOpen, Gauge, GitMerge, Hash, History, Hourglass, Inbox, Info,
  KeyRound, LayoutGrid, Link2, ListChecks, Loader2, Lock, LogOut, Mail, Maximize2, Menu,
  Minimize2, Minus, Moon, MoreHorizontal, MoreVertical, Nfc, OctagonAlert, Paperclip, Pause,
  PencilLine, Pin, Play, Plus, RefreshCw, RotateCcw, Search, Send, Settings, Shield,
  ShieldCheck, SlidersHorizontal, Sparkles, Square, SquarePen, Star, Sun, Table2, Tag,
  ThumbsDown, ThumbsUp, Timer, Trash2, TrendingUp, TriangleAlert, Undo2, Upload, User,
  UserCheck, UserPlus, Users, Utensils, Wallet, X, Zap,
} from "lucide-react";

/**
 * Beacon icon registry.
 *
 * The `<Icon name="…" />` call signature is unchanged from the original
 * hand-drawn set — every one of the ~600 existing call sites keeps working
 * — but the glyphs now come from Lucide, so weight, corner radius, terminal
 * style and optical size are consistent across the whole application
 * instead of drifting per hand-authored path.
 *
 * Names are the historic Beacon keys on the left, mapped to their Lucide
 * equivalent on the right. Add new entries here rather than importing
 * Lucide directly in a page, so the registry stays the single inventory of
 * every glyph the product uses.
 */
const REGISTRY = {
  // ---- navigation / chrome
  search: Search,
  menu: Menu,
  filter: Filter,
  sliders: SlidersHorizontal,
  sort: ArrowUpDown,
  forward: ArrowRight,
  back: ArrowLeft,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronsLeft: ChevronsLeft,
  chevronsRight: ChevronsRight,
  chevronsUpDown: ChevronsUpDown,
  more: MoreHorizontal,
  moreVertical: MoreVertical,
  ellipsis: Ellipsis,
  columns: Columns3,
  grid: LayoutGrid,
  table: Table2,
  maximize: Maximize2,
  minimize: Minimize2,
  external: ExternalLink,

  // ---- actions
  plus: Plus,
  minus: Minus,
  edit: PencilLine,
  compose: SquarePen,
  copy: Copy,
  trash: Trash2,
  undo: Undo2,
  restore: RotateCcw,
  refresh: RefreshCw,
  export: Upload,
  download: Download,
  upload: Upload,
  send: Send,
  link: Link2,
  merge: GitMerge,
  pin: Pin,
  tag: Tag,
  bookmark: Bookmark,

  // ---- state / status
  check: Check,
  checkAll: CheckCheck,
  checkCircle: CheckCircle2,
  x: X,
  close: X,
  ban: Ban,
  warn: TriangleAlert,
  danger: OctagonAlert,
  info: Info,
  help: CircleHelp,
  dot: CircleDot,
  square: Square,
  pause: Pause,
  play: Play,
  spinner: Loader2,
  hourglass: Hourglass,

  // ---- objects / domain
  note: FileText,
  file: File,
  files: Files,
  folder: FolderOpen,
  attachment: Paperclip,
  clipboard: ClipboardList,
  checklist: ListChecks,
  alignLeft: AlignLeft,
  hash: Hash,
  braces: Braces,
  briefcase: Briefcase,
  building: Building2,
  wallet: Wallet,
  card: CreditCard,
  flag: Flag,
  trend: TrendingUp,
  chart: ChartColumn,
  gauge: Gauge,
  blocks: Blocks,
  inbox: Inbox,
  star: Star,

  // ---- time
  calendar: Calendar,
  calendarDays: CalendarDays,
  calendarClock: CalendarClock,
  clock: Clock,
  timer: Timer,
  history: History,
  utensils: Utensils,

  // ---- people / auth
  user: User,
  users: Users,
  userCheck: UserCheck,
  userPlus: UserPlus,
  lock: Lock,
  key: KeyRound,
  shield: Shield,
  shieldCheck: ShieldCheck,
  logout: LogOut,
  mail: Mail,
  eye: Eye,
  eyeOff: EyeOff,
  nfc: Nfc,

  // ---- feedback
  thumbsUp: ThumbsUp,
  thumbsDown: ThumbsDown,
  bell: Bell,
  bellRing: BellRing,
  sparkles: Sparkles,
  bolt: Zap,

  // ---- appearance
  sun: Sun,
  moon: Moon,
  settings: Settings,
};

/**
 * @param {string}  name   registry key (see REGISTRY above)
 * @param {number}  size   px, applied to both axes
 * @param {number}  stroke stroke width; Lucide's own default is 2, Beacon
 *                         runs slightly lighter so icons sit beside 12–14px
 *                         text without out-weighting it
 */
export const Icon = ({ name, size = 16, stroke = 1.75, className, ...rest }) => {
  const Glyph = REGISTRY[name];
  if (!Glyph) {
    if (import.meta.env?.DEV && name) {
      console.warn(`[Icon] unknown icon name: "${name}"`);
    }
    return null;
  }
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={stroke}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    />
  );
};

export const ICON_NAMES = Object.keys(REGISTRY);
