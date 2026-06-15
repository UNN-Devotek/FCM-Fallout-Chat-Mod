// Ambient declarations for Remotion composition files in marketing/promo/src/.
// Those files live outside admin-dashboard/ so TypeScript can't resolve their
// dependencies (react, remotion) via the normal node_modules walk.
// Vite resolves the actual source via the @promo alias in vite.config.ts.
// LandingPage.tsx casts each import to React.ComponentType<any>.

declare module '@promo/ChatFeedGif' {
  const ChatFeedGif: import('react').ComponentType<Record<string, never>>;
  export { ChatFeedGif };
}
declare module '@promo/WikiFlowVideo' {
  const WikiFlowGif: import('react').ComponentType<Record<string, never>>;
  export { WikiFlowGif };
}
declare module '@promo/CommandsGif' {
  const CommandsGif: import('react').ComponentType<Record<string, never>>;
  export { CommandsGif };
}
declare module '@promo/PartyGif' {
  const PartyGif: import('react').ComponentType<Record<string, never>>;
  export { PartyGif };
}
declare module '@promo/InfestGif' {
  const InfestGif: import('react').ComponentType<Record<string, never>>;
  export { InfestGif };
}
