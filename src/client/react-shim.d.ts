declare module 'react' {
  export type ReactNode = unknown
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<T>(initial: T): { current: T }
}
