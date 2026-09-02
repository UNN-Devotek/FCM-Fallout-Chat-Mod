export function shouldStartBackgroundJobs(
  nodeEnv: string,
  runningUnderTest = typeof process !== 'undefined' && !!process.env.JEST_WORKER_ID,
): boolean {
  return nodeEnv !== 'test' && !runningUnderTest;
}
