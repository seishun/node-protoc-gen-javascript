# node-protoc-gen-javascript
Node.js port of the JavaScript protoc code generator

## Usage

Install this module globally, e.g.:

```
npm i -g seishun/node-protoc-gen-javascript
```

Use it the same way as protoc's JavaScript generator, except with
`--javascript_out` instead of `--js_out`. It's intended to work exactly the same
for well-formed .proto files and command line parameters, minus unimplemented
functionality (see below).

## Not implemented

* Annotations (`annotate_code` option)
* One output file per SCC (`import_style=closure` without `one_output_file_per_input_file` and `library`)
