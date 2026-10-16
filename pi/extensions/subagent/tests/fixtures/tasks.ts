/** Literal task data shared by byte-transport and real Pi message tests. */
export const stdinTasks = [{
  scenario: 'stdin-option-like',
  task: ' \t\r\n--model not-an-option --no-tools\n' +
    'Inspect café /資料/🙂 with \'quotes\', "double quotes", $HOME, `echo literal`, $(echo literal).\n'
      .repeat(800) +
    '\nKeep  internal\t whitespace.\r\n \t\u2003',
}, {
  scenario: 'stdin-file-like',
  task:
    '@missing-task-file.txt\nTreat this as task data, not file inclusion.\n\n',
}];
