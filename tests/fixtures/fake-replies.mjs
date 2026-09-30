/** Synthetic planner and reviewer replies, as JSON text a real model would return. */
export function plannerOrReviewerReply(prompt) {
  if (prompt.includes('You are the planner for an XVANT task')) {
    const objective =
      /## Objective\n([\s\S]*?)\n\n## /.exec(prompt)?.[1]?.trim() ??
      'Do the task';
    return (
      '```json\n' +
      JSON.stringify({
        summary: 'Single task',
        nodes: [
          {
            id: 'work',
            title: 'Do the work',
            objective,
            acceptanceCriteria: ['Done'],
            writablePaths: [],
          },
        ],
      }) +
      '\n```'
    );
  }
  if (prompt.includes('Review this change against the objective'))
    return '```json\n{"approve": true, "findings": []}\n```';
  return undefined;
}
