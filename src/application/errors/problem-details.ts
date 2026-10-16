export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  timestamp: string;
}

export function createProblemDetails(
  status: number,
  title: string,
  detail: string,
  instance: string,
): ProblemDetails {
  return {
    type: `https://api.jungle.gaming/errors/${status}`,
    title,
    status,
    detail,
    instance,
    timestamp: new Date().toISOString(),
  };
}
