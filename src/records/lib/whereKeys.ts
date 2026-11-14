/** A record's location as `--json` carries it: `$file` and `$repo` (null = outside every repo here). */
export const whereKeys = ({ file, repo }: { file: string; repo: string | null }) => ({ $file: file, $repo: repo })
