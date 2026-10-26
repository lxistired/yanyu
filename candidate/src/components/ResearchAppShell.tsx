import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  CircleHelp,
  Folder,
  House,
  LayoutGrid,
  Menu,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ResearchAppShellProps,
  ResearchNavigationItem,
  ResearchPage,
} from './research-experience-types';
import './research-experience.css';

export type ResearchGroup = 'home' | 'research' | 'library' | 'mine';
interface NavigationGroup {
  id: ResearchGroup;
  label: string;
  root: ResearchPage;
  icon: LucideIcon;
  pages: readonly ResearchPage[];
}

export const RESEARCH_GROUPS: readonly NavigationGroup[] = [
  { id: 'home', label: '首页', root: 'home', icon: House, pages: ['home', 'roadshow', 'tasks'] },
  {
    id: 'research',
    label: '研究',
    root: 'chat',
    icon: Sparkles,
    pages: ['chat', 'research', 'planner', 'scheduled'],
  },
  {
    id: 'library',
    label: '资料',
    root: 'files',
    icon: Folder,
    pages: ['files', 'documents', 'reader', 'companies', 'materials'],
  },
  {
    id: 'mine',
    label: '我的',
    root: 'settings',
    icon: LayoutGrid,
    pages: ['settings', 'workspace', 'organization', 'calendar', 'automation', 'usage'],
  },
];

export function researchGroupForPage(page: ResearchPage): NavigationGroup {
  return RESEARCH_GROUPS.find((group) => group.pages.includes(page)) ?? RESEARCH_GROUPS[0];
}

function usesCompactMobileHeader(page: ResearchPage): boolean {
  const group = researchGroupForPage(page);
  return page === 'companies' || (group.id === 'mine' && page !== group.root);
}

const settingsItem: ResearchNavigationItem = { id: 'settings', name: '服务与接入', icon: Settings2 };
const mineSections: readonly { title: string; pages: readonly ResearchPage[] }[] = [
  { title: '工作与协作', pages: ['workspace', 'organization'] },
  { title: '安排与记录', pages: ['calendar', 'automation', 'usage'] },
  { title: '设置与帮助', pages: ['settings'] },
];

function DestinationButton({
  item,
  activePage,
  onNavigate,
}: {
  item: ResearchNavigationItem;
  activePage: ResearchPage;
  onNavigate: ResearchAppShellProps['onNavigate'];
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className="rs-destination"
      aria-current={activePage === item.id ? 'page' : undefined}
      onClick={() => onNavigate(item.id)}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <span>{item.name}</span>
      <ChevronRight className="rs-destination-chevron" size={17} aria-hidden="true" />
    </button>
  );
}

/** View-only shell: no URL, request, storage, recorder or identity ownership. */
export function ResearchAppShell({
  activePage,
  navigation,
  currentModeLabel,
  statusSlot,
  children,
  onNavigate,
  onOpenHelp,
}: ResearchAppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const secondaryRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuFocusRef = useRef<HTMLElement | null>(null);
  const previousPageRef = useRef(activePage);
  const navigationId = useId();
  const [mobileMenu, setMobileMenu] = useState({ page: activePage, open: false });
  // Reset only the presentation menu on an owner-controlled route change. Children stay mounted.
  if (mobileMenu.page !== activePage) setMobileMenu({ page: activePage, open: false });
  const activeGroup = researchGroupForPage(activePage);
  const compactMobilePage = usesCompactMobileHeader(activePage);
  const mobileMenuOpen = mobileMenu.page === activePage && mobileMenu.open;
  useLayoutEffect(() => {
    const changedPage = previousPageRef.current !== activePage;
    previousPageRef.current = activePage;
    const previousFocus = menuFocusRef.current;
    if (changedPage && previousFocus) {
      const focused = previousFocus.ownerDocument.activeElement;
      // Do not take focus back if the owner already put it in main content or a dialog.
      if (focused === previousFocus || focused === previousFocus.ownerDocument.body) {
        const button = menuButtonRef.current;
        const visibleButton =
          button && button.ownerDocument.defaultView?.getComputedStyle(button).display !== 'none';
        (compactMobilePage && visibleButton ? button : mainRef.current)?.focus();
      }
    }
    if (!mobileMenuOpen) menuFocusRef.current = null;
  }, [activePage, compactMobilePage, mobileMenuOpen]);
  useEffect(() => {
    if (mobileMenuOpen) secondaryRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [mobileMenuOpen]);
  const navigate: ResearchAppShellProps['onNavigate'] = (page) => {
    const menuButton = menuButtonRef.current;
    if (
      mobileMenuOpen &&
      menuButton &&
      menuButton.ownerDocument.defaultView?.getComputedStyle(menuButton).display !== 'none'
    ) {
      // The owner may accept the same route, delay its update, or switch out of this group.
      // Focus a surviving visible target before the menu hides its activated destination.
      const keepsCompactHeader = usesCompactMobileHeader(page);
      (keepsCompactHeader ? menuButton : mainRef.current)?.focus();
    }
    setMobileMenu({ page: activePage, open: false });
    onNavigate(page);
  };
  const closeMobileMenu = () => {
    setMobileMenu({ page: activePage, open: false });
    const menuButton = menuButtonRef.current;
    if (menuButton && menuButton.ownerDocument.defaultView?.getComputedStyle(menuButton).display !== 'none')
      menuButton.focus();
  };
  const items = activeGroup.pages
    .map((id) => navigation.find((item) => item.id === id) ?? (id === 'settings' ? settingsItem : undefined))
    .filter((item): item is ResearchNavigationItem => !!item);
  const visibleItems = activeGroup.id === 'mine' ? items : items.slice(0, 3);
  const moreItems = activeGroup.id === 'mine' ? [] : items.slice(3);
  const activeMore = moreItems.find((item) => item.id === activePage);
  const activeTitle = navigation.find((item) => item.id === activePage)?.name ?? '服务与接入';

  return (
    <div
      className={`rs-shell rs-group-${activeGroup.id}${compactMobilePage ? ' rs-compact-page' : ''}${mobileMenuOpen ? ' rs-mobile-menu-open' : ''}`}
      onFocusCapture={(event) => {
        const button = menuButtonRef.current;
        const inMenu =
          secondaryRef.current?.contains(event.target) || headerRef.current?.contains(event.target);
        menuFocusRef.current =
          mobileMenuOpen &&
          inMenu &&
          button &&
          button.ownerDocument.defaultView?.getComputedStyle(button).display !== 'none'
            ? event.target
            : null;
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next && !secondaryRef.current?.contains(next) && !headerRef.current?.contains(next))
          menuFocusRef.current = null;
      }}
    >
      <button type="button" className="rs-skip" onClick={() => mainRef.current?.focus()}>
        跳到主要内容
      </button>
      <aside className="rs-rail" aria-label="工作空间导航">
        <button
          type="button"
          className="rs-brand"
          onClick={() => navigate('home')}
          aria-label="研屿 · 返回首页"
        >
          <span className="rs-brand-mark" aria-hidden="true">
            <BookOpen size={22} strokeWidth={1.6} />
          </span>
          <span>
            研屿<small>让研究有迹可循</small>
          </span>
        </button>
        <nav className="rs-primary" aria-label="主导航">
          {RESEARCH_GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <button
                type="button"
                key={group.id}
                className="rs-primary-item"
                aria-current={activeGroup.id === group.id ? 'page' : undefined}
                onClick={() => navigate(group.root)}
              >
                <span className="rs-primary-icon">
                  <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span>{group.label}</span>
                <ChevronRight className="rs-primary-chevron" size={16} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
        <nav
          ref={secondaryRef}
          id={`${navigationId}-destinations`}
          key={activeGroup.id}
          className={`rs-secondary${activePage === 'home' ? ' rs-secondary-home-root' : ''}`}
          aria-label={`${activeGroup.label}分组导航`}
          onKeyDown={(event) => {
            if (compactMobilePage && mobileMenuOpen && event.key === 'Escape') {
              event.preventDefault();
              closeMobileMenu();
            }
          }}
        >
          {compactMobilePage && (
            <button type="button" className="rs-mobile-menu-close" onClick={closeMobileMenu}>
              收起{activeGroup.label}工具
            </button>
          )}
          <p className="rs-secondary-caption">{activeGroup.label}工具</p>
          <div className="rs-secondary-items">
            {activeGroup.id === 'mine' ? (
              <>
                <div className="rs-mine-intro">
                  <span className="rs-mine-mark" aria-hidden="true">
                    研
                  </span>
                  <div>
                    <strong>你的研究空间</strong>
                    <p>{currentModeLabel}</p>
                  </div>
                </div>
                {mineSections.map((section) => (
                  <div className="rs-mine-section" key={section.title}>
                    <p>{section.title}</p>
                    <div className="rs-mine-list">
                      {section.pages.map((page) => {
                        const item = items.find((candidate) => candidate.id === page);
                        return item ? (
                          <DestinationButton
                            key={page}
                            item={item}
                            activePage={activePage}
                            onNavigate={navigate}
                          />
                        ) : null;
                      })}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              visibleItems.map((item) => (
                <DestinationButton key={item.id} item={item} activePage={activePage} onNavigate={navigate} />
              ))
            )}
            {moreItems.length > 0 && (
              <details className="rs-more" key={activePage} open={activeMore ? true : undefined}>
                <summary>
                  <span>{activeMore ? activeMore.name : '更多工具'}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="rs-more-items">
                  {moreItems.map((item) => (
                    <DestinationButton
                      key={item.id}
                      item={item}
                      activePage={activePage}
                      onNavigate={navigate}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        </nav>
        <div className="rs-rail-foot">
          <p>
            资料、线索与思考
            <br />
            在这里，慢慢连起来
          </p>
          <button type="button" onClick={() => navigate('settings')}>
            设置与使用说明 <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <header
        ref={headerRef}
        className="rs-header"
        onKeyDown={(event) => {
          if (compactMobilePage && mobileMenuOpen && event.key === 'Escape') {
            event.preventDefault();
            closeMobileMenu();
          }
        }}
      >
        <div className="rs-header-title">
          {compactMobilePage && (
            <button
              type="button"
              className="rs-mobile-back"
              aria-label={`返回${activeGroup.label}`}
              onClick={() => navigate(activeGroup.root)}
            >
              <ArrowLeft size={21} aria-hidden="true" />
            </button>
          )}
          <span className="rs-mobile-title">
            {compactMobilePage ? activeTitle : activeGroup.id === 'home' ? '研屿' : activeGroup.label}
          </span>
          <span className="rs-desktop-title">
            {activeGroup.label}
            <ChevronRight size={15} aria-hidden="true" />
            <strong>{activeTitle}</strong>
          </span>
        </div>
        {compactMobilePage && (
          <button
            ref={menuButtonRef}
            type="button"
            className="rs-mobile-menu-toggle"
            aria-label={`${mobileMenuOpen ? '收起' : '打开'}${activeGroup.label}工具菜单`}
            aria-expanded={mobileMenuOpen}
            aria-controls={`${navigationId}-destinations ${navigationId}-actions`}
            onClick={() => setMobileMenu({ page: activePage, open: !mobileMenuOpen })}
          >
            <Menu size={20} aria-hidden="true" />
            <span>工具</span>
          </button>
        )}
        <div id={`${navigationId}-actions`} className="rs-header-actions">
          <button
            type="button"
            className="rs-mode"
            onClick={() => navigate('settings')}
            aria-label={`当前模式：${currentModeLabel}；查看设置`}
          >
            <span>{currentModeLabel}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rs-icon-button"
            aria-label="打开资料检索"
            onClick={() => navigate('research')}
          >
            <Search size={22} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rs-icon-button"
            aria-label="近期本地资料"
            onClick={() => navigate('tasks')}
          >
            <Clock3 size={22} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {onOpenHelp && (
            <button type="button" className="rs-icon-button" aria-label="使用说明" onClick={onOpenHelp}>
              <CircleHelp size={22} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {statusSlot != null && <div className="rs-status-slot">{statusSlot}</div>}
      <main ref={mainRef} tabIndex={-1} className="rs-main">
        {children}
      </main>
    </div>
  );
}

export type {
  ResearchAppShellProps,
  ResearchNavigationItem,
  ResearchPage,
} from './research-experience-types';
