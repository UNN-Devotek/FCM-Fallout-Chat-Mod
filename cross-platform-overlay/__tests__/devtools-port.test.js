import core from '../overlay-core.js';

function commandLine(initial = []) {
  const switches = new Map(initial);
  return {
    switches,
    hasSwitch: name => switches.has(name),
    appendSwitch: (name, value) => switches.set(name, value),
  };
}

describe('development DevTools endpoint', () => {
  it('retains the normal development port when none was supplied', () => {
    const cli = commandLine();
    core.configureDevelopmentDevtools(cli, false);
    expect(cli.switches.get('remote-debugging-port')).toBe('9222');
  });

  it.each(['0', '9345'])('preserves explicit port %s for independent instances', port => {
    const cli = commandLine([['remote-debugging-port', port]]);
    core.configureDevelopmentDevtools(cli, false);
    expect(cli.switches.get('remote-debugging-port')).toBe(port);
  });

  it('does not enable development debugging in packaged applications', () => {
    const cli = commandLine();
    core.configureDevelopmentDevtools(cli, true);
    expect([...cli.switches]).toEqual([]);
  });
});
