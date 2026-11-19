/**
 * An exact version — what a module preset pins and `--save-exact` writes. Its own file, not in
 * install, because compile reads it and install imports compile.
 */
export const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
