declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
    [key: string]: unknown;
  }
  type Matcher = (input: string) => boolean;
  function picomatch(pattern: string | string[], options?: PicomatchOptions): Matcher;
  namespace picomatch {
    function scan(input: string, options?: PicomatchOptions): unknown;
    function makeRe(input: string, options?: PicomatchOptions): RegExp;
  }
  export default picomatch;
}
