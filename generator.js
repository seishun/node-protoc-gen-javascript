const { FieldOptions } = require('google-protobuf/google/protobuf/descriptor_pb');
const { CodeGenerator } = require('protoc-plugin/code_generator');
const { Descriptor, FieldDescriptor, FileDescriptor } = require('protoc-plugin/descriptor');

const wellKnownTypesJs = require('./well_known_types_embed');

function getFileNameExtension(options) {
  return options.get("import_style") == "closure" ? options.get("extension") || ".js" : "_pb.js";
}

function getOutputMode(options) {
  // We use one output file per input file if we are not using Closure or if
  // this is explicitly requested.
  if (options.get("import_style") != "closure" || options.has("one_output_file_per_input_file")) {
    return "one_output_file_per_input_file";
  }

  // If a library name is provided, we put everything in that one file.
  if (options.get("library")) {
    return "everything_in_one_file";
  }

  // Otherwise, we create one output file per SCC.
  return "one_output_file_per_SCC";
}

class Generator extends CodeGenerator {
  generateAll(files, parameter, context) {
    const options = new Map([
      ["output_dir", "."],
      ["namespace_prefix", ""],
      ["import_style", "closure"],
      ["library", ""],
      ["extension", ".js"],
      ...parameter.split(',').map(part => part.split(/=(.*)/))
    ]);

    if (getOutputMode(options) == "everything_in_one_file") {
      // All output should go in a single file.
      let filename = options.get("output_dir") + "/" + options.get("library") +
                     getFileNameExtension(options);
      const output = context.open(filename);
      const printer = data => context.write(output, data);

      // Pull out all extensions -- we need these to generate all
      // provides/requires.
      const extensions = [];
      for (const file of files) {
        for (const extension of file.getExtensionList()) {
          extensions.push(extension);
        }
      }

      if (files.length == 1) {
        this.generateHeader(options, files[0], printer);
      } else {
        this.generateHeader(options, null, printer);
      }

      const provided = new Set();
      this.findProvides(options, printer, files, provided);
      this.findProvidesForFields(options, printer, extensions, provided);
      this.generateProvides(options, printer, provided);
      this.generateTestOnly(options, printer);
      this.generateRequiresForLibrary(options, printer, files, provided);

      this.generateFilesInDepOrder(options, printer, files);

      for (const extension of extensions) {
        if (shouldGenerateExtension(extension)) {
          this.generateExtension(options, printer, extension);
        }
      }

      if (options.get("annotate_code")) {
        throw "not implemented";
      }
    } else if (getOutputMode(options) == "one_output_file_per_SCC") {
      // why is this even a thing?
      throw "not implemented";
    } else /* getOutputMode(options) == "one_output_file_per_input_file" */ {
      // Generate one output file per input (.proto) file.

      for (const file of files) {
        if (!this.generateFile(file, options, context, false)) {
          return false;
        }
      }
    }
    return true;
  }

  getSupportedFeatures() {
    return Generator.Feature.FEATURE_PROTO3_OPTIONAL;
  }

  generateHeader(options, file, printer) {
    if (file != null) {
      printer(`// source: ${file.getName()}\n`);
    }
    printer(
        `/**\n` +
        ` * @fileoverview\n` +
        ` * @enhanceable\n` +
        ` * @suppress {messageConventions} JS Compiler reports an ` +
        `error if a variable or\n` +
        ` *     field starts with 'MSG_' and isn't a translatable ` +
        `message.\n` +
        ` * @public\n` +
        ` */\n` +
        `// GENERATED CODE -- DO NOT EDIT!\n` +
        `\n`);
  }

  // Generate goog.provides() calls.
  findProvides(options, printer, files, provided) {
    for (const file of files) {
      this.findProvidesForFile(options, printer, file, provided);
    }

    printer(`\n`);
  }

  findProvidesForFile(options, printer, file, provided) {
    for (const desc of file.getMessageTypeList()) {
      this.findProvidesForMessage(options, printer, desc, provided);
    }
    for (const enumdesc of file.getEnumTypeList()) {
      this.findProvidesForEnum(options, printer, enumdesc, provided);
    }
  }

  findProvidesForMessage(options, printer, desc, provided) {
    if (ignoreMessage(desc)) {
      return;
    }
    
    let name = getMessagePath(options, desc);
    provided.add(name);

    for (const e of desc.getEnumTypeList()) {
      this.findProvidesForEnum(options, printer, e, provided);
    }

    findProvidesForOneOfEnums(options, printer, desc, provided);

    for (const d of desc.getNestedTypeList()) {
      this.findProvidesForMessage(options, printer, d, provided);
    }
  }

  findProvidesForEnum(options, printer, enumdesc, provided) {
    let name = getEnumPath(options, enumdesc);
    provided.add(name);
  }

  // For extension fields at file scope.
  findProvidesForFields(options, printer, fields, provided) {
    for (const field of fields) {
      if (ignoreField(field)) {
        continue;
      }

      let name = getNamespace(options, field.getFile()) + "." +
                 JSObjectFieldName(options, field);
      provided.add(name);
    }
  }

  // Print the goog.provides() found by the methods above.
  generateProvides(options, printer, provided) {
    for (let namespaceObject of [...provided].sort()) {
      if (options.get("import_style") == "closure") {
        printer(`goog.provide('${namespaceObject}');\n`);
      } else {
        // We aren't using Closure's import system, but we use goog.exportSymbol()
        // to construct the expected tree of objects, eg.
        //
        //   goog.exportSymbol('foo.bar.Baz', null, this);
        //
        //   // Later generated code expects foo.bar = {} to exist:
        //   foo.bar.Baz = function() { /* ... */ }

        // Do not use global scope in strict mode
        if (options.get("import_style") == "commonjs_strict") {
          // Remove "proto." from the namespace object
          namespaceObject = namespaceObject.slice(6);
          printer(`goog.exportSymbol('${namespaceObject}', null, proto);\n`);
        } else {
          printer(`goog.exportSymbol('${namespaceObject}', null, global);\n`);
        }
      }
    }
  }

  // Generate goog.setTestOnly() if indicated.
  generateTestOnly(options, printer) {
    if (options.get("testonly")) {
      printer(`goog.setTestOnly();\n\n`);
    }
    printer(`\n`);
  }

  // Generate goog.requires() calls.
  generateRequiresForLibrary(options, printer, files, provided) {
    // For Closure imports we need to import every message type individually.
    const required = new Set();
    const forwards = new Set();
    let haveExtensions = false;
    let haveMap = false;
    let haveMessage = false;

    for (const file of files) {
      for (const desc of file.getMessageTypeList()) {
        if (!ignoreMessage(desc)) {
          if (this.findRequiresForMessage(options, desc, required, forwards, haveMessage))
            haveMessage = true;
        }
      }

      if (!haveExtensions && hasExtensions(file)) {
        haveExtensions = true;
      }

      if (!haveMap && fileHasMap(options, file)) {
        haveMap = true;
      }

      for (const extension of file.getExtensionList()) {
        if (ignoreField(extension)) {
          continue;
        }
        if (extension.getContainingType().getFullName() !=
            "google.protobuf.bridge.MessageSet") {
          required.add(getMessagePath(options, extension.getContainingType()));
        }
        this.findRequiresForField(options, extension, required, forwards);
        haveExtensions = true;
      }
    }

    this.generateRequiresImpl(options, printer, required, forwards, provided,
                              /* requireJspb = */ haveMessage,
                              /* requireExtension = */ haveExtensions,
                              /* requireMap = */ haveMap);
  }

  generateRequiresImpl(options, printer, required, forwards, provided, requireJspb, requireExtension, requireMap) {
    if (requireJspb) {
      required.add("jspb.Message");
      required.add("jspb.BinaryReader");
      required.add("jspb.BinaryWriter");
    }
    if (requireExtension) {
      required.add("jspb.ExtensionFieldBinaryInfo");
      required.add("jspb.ExtensionFieldInfo");
    }
    if (requireMap) {
      required.add("jspb.Map");
    }

    for (let namespaceObject of [...required].sort()) {
      if (provided.has(namespaceObject)) {
        continue;
      }
      printer(`goog.require('${namespaceObject}');\n`);
    }

    printer(`\n`);

    for (let namespaceObject of [...forwards].sort()) {
      if (provided.has(namespaceObject)) {
        continue;
      }
      printer(`goog.forwardDeclare('${namespaceObject}');\n`);
    }
  }

  findRequiresForMessage(options, desc, required, forwards, haveMessage) {
    if (!namespaceOnly(desc)) {
      haveMessage = true;
      for (const field of desc.getFieldList()) {
        if (ignoreField(field)) {
          continue;
        }
        this.findRequiresForField(options, field, required, forwards);
      }
    }

    for (const field of desc.getExtensionList()) {
      if (ignoreField(field)) {
        continue;
      }
      this.findRequiresForExtension(options, field, required, forwards);
    }

    for (const nestedType of desc.getNestedTypeList()) {
      if (this.findRequiresForMessage(options, nestedType, required, forwards,
                                      haveMessage))
        haveMessage = true;
    }
    return haveMessage;
  }

  findRequiresForField(options, field, required, forwards) {
    if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_ENUM &&
        // N.B.: file-level extensions with enum type do *not* create
        // dependencies, as per original codegen.
        !(field.isExtension() && field.getExtensionScope() == null)) {
      if (options.get("add_require_for_enums")) {
        required.add(getEnumPath(options, field.getEnumType()));
      } else {
        forwards.add(getEnumPath(options, field.getEnumType()));
      }
    } else if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
      if (!ignoreMessage(field.getMessageType())) {
        required.add(getMessagePath(options, field.getMessageType()));
      }
    }
  }

  findRequiresForExtension(options, field, required, forwards) {
    if (field.getContainingType().getFullName() != "google.protobuf.bridge.MessageSet") {
      required.add(getMessagePath(options, field.getContainingType()));
    }
    this.findRequiresForField(options, field, required, forwards);
  }

  // Generate all things in a proto file into one file.
  // If useShortName is true, the generated file's name will only be short
  // name that without directory, otherwise filename equals file.getName()
  generateFile(file, options, context, useShortName) {
    let filename =
        options.get("output_dir") + "/" +
        getJSFilename(options, useShortName
                                   ? file.getName().split('/').pop()
                                   : file.getName());
    const output = context.open(filename);
    const printer = data => context.write(output, data);

    this.generateHeader(options, file, printer);

    // Generate "require" statements.
    if ((options.get("import_style") == "commonjs" ||
         options.get("import_style") == "commonjs_strict")) {
      printer(`var jspb = require('google-protobuf');\n`);
      printer(`var goog = jspb;\n`);

      // Do not use global scope in strict mode
      if (options.get("import_style") == "commonjs_strict") {
        printer(`var proto = {};\n\n`);
      } else {
        printer(`var global = Function('return this')();\n\n`);
      }

      for (const dep of file.getDependencyList()) {
        const name = dep.getName();
        const fileName = getRootPath(file.getName(), name) + getJSFilename(options, name);
        printer(
            `var ${moduleAlias(name)} = require('${fileName}');\n` +
            `goog.object.extend(proto, ${moduleAlias(name)});\n`);
      }
    }

    const provided = new Set();
    const extensions = new Set();
    for (const extension of file.getExtensionList()) {
      // We honor the jspb::ignore option here only when working with
      // Closure-style imports. Use of this option is discouraged and so we want
      // to avoid adding new support for it.
      if (options.get("import_style") == "closure" &&
          ignoreField(extension)) {
        continue;
      }
      provided.add(getNamespace(options, file) + "." +
                   JSObjectFieldName(options, extension));
      extensions.add(extension);
    }

    this.findProvidesForFile(options, printer, file, provided);
    this.generateProvides(options, printer, provided);
    const files = [];
    files.push(file);
    if (options.get("import_style") == "closure") {
      this.generateRequiresForLibrary(options, printer, files, provided);
    }

    this.generateClassesAndEnums(options, printer, file);

    // Generate code for top-level extensions. Extensions nested inside messages
    // are emitted inside generateClassesAndEnums().
    for (const extension of extensions) {
      this.generateExtension(options, printer, extension);
    }

    // if provided is empty, do not export anything
    if (options.get("import_style") == "commonjs" &&
        provided.size) {
      const packageName = getNamespace(options, file);
      printer(`goog.object.extend(exports, ${packageName});\n`);
    } else if (options.get("import_style") == "commonjs_strict") {
      printer(`goog.object.extend(exports, proto);\n`);
    }

    // Emit well-known type methods.
    for (const toc of wellKnownTypesJs) {
      let name = "google/protobuf/" + toc.name;
      if (name == stripProto(file.getName()) + ".js") {
        printer(toc.data);
      }
    }

    if (options.get("annotate_code")) {
      throw "not implemented";
    }

    return true;
  }

  // Generate definitions for all message classes and enums in all files,
  // processing the files in dependence order.
  generateFilesInDepOrder(options, printer, files) {
    // Build a Set over all files so that the DFS can detect when it recurses
    // into a dep not specified in the user's command line.
    const allFiles = new Set(files);
    // Track the in-progress set of files that have been generated already.
    const generated = new Set();
    for (const file of files) {
      this.generateFileAndDeps(options, printer, file, allFiles, generated);
    }
  }

  // Helper for above.
  generateFileAndDeps(options, printer, root, allFiles, generated) {
    // Skip if already generated.
    if (generated.has(root)) {
      return;
    }
    generated.add(root);

    // Generate all dependencies before this file's content.
    for (const dep of root.getDependencyList()) {
      this.generateFileAndDeps(options, printer, dep, allFiles, generated);
    }

    // Generate this file's content.  Only generate if the file is part of the
    // original set requested to be generated; i.e., don't take all transitive
    // deps down to the roots.
    if (allFiles.has(root)) {
      this.generateClassesAndEnums(options, printer, root);
    }
  }
  
  // Generate definitions for all message classes and enums.
  generateClassesAndEnums(options, printer, file) {
    for (const desc of file.getMessageTypeList()) {
      this.generateClassConstructorAndDeclareExtensionFieldInfo(options, printer,
                                                                desc);
    }
    for (const desc of file.getMessageTypeList()) {
      this.generateClass(options, printer, desc);
    }
    for (const enumdesc of file.getEnumTypeList()) {
      this.generateEnum(options, printer, enumdesc);
    }
  }

  generateFieldValueExpression(printer, objReference, field, useDefault) {
    const isFloatOrDouble =
        field.getCppType() == FieldDescriptor.CppType.CPPTYPE_FLOAT ||
        field.getCppType() == FieldDescriptor.CppType.CPPTYPE_DOUBLE;
    const isBoolean = field.getCppType() == FieldDescriptor.CppType.CPPTYPE_BOOL;

    const withDefault = useDefault ? "WithDefault" : "";
    const defaultArg =
        useDefault ? ", " + JSFieldDefault(field) : "";
    const cardinality = field.isRepeated() ? "Repeated" : "";
    let type = "";
    if (isFloatOrDouble) {
      type = "FloatingPoint";
    }
    if (isBoolean) {
      type = "Boolean";
    }

    // Prints the appropriate function, among:
    // - getField
    // - getBooleanField
    // - getFloatingPointField => Replaced by getOptionalFloatingPointField to
    //   preserve backward compatibility.
    // - getFieldWithDefault
    // - getBooleanFieldWithDefault
    // - getFloatingPointFieldWithDefault
    // - getRepeatedField
    // - getRepeatedBooleanField
    // - getRepeatedFloatingPointField
    if (isFloatOrDouble && !field.isRepeated() && !useDefault) {
      printer(
          `jspb.Message.getOptionalFloatingPointField(${objReference}, ` +
          `${JSFieldIndex(field)}${defaultArg})`);
    } else {
      printer(
          `jspb.Message.get${cardinality}${type}Field${withDefault}(${objReference}, ` +
          `${JSFieldIndex(field)}${defaultArg})`);
    }
  }

  // Generate definition for one class.
  generateClass(options, printer, desc) {
    if (ignoreMessage(desc)) {
      return;
    }

    if (!namespaceOnly(desc)) {
      printer(`\n`);
      this.generateClassFieldInfo(options, printer, desc);


      this.generateClassToObject(options, printer, desc);
      // These must come *before* the extension-field info generation in
      // GenerateClassRegistration so that references to the binary
      // serialization/deserialization functions may be placed in the extension
      // objects.
      this.generateClassDeserializeBinary(options, printer, desc);
      this.generateClassSerializeBinary(options, printer, desc);
    }

    // Recurse on nested types. These must come *before* the extension-field
    // info generation in GenerateClassRegistration so that extensions that
    // reference nested types proceed the definitions of the nested types.
    for (const e of desc.getEnumTypeList()) {
      this.generateEnum(options, printer, e);
    }
    for (const d of desc.getNestedTypeList()) {
      this.generateClass(options, printer, d);
    }

    if (!namespaceOnly(desc)) {
      this.generateClassRegistration(options, printer, desc);
      this.generateClassFields(options, printer, desc);

      if (options.get("import_style") != "closure") {
        for (const extension of desc.getExtensionList()) {
          this.generateExtension(options, printer, extension);
        }
      }
    }
  }

  generateClassConstructor(options, printer, desc) {
    const classPrefix = getMessagePathPrefix(options, desc);
    let className = desc.getName();
    printer(
        `/**\n` +
        ` * Generated by JsPbCodeGenerator.\n` +
        ` * @param {Array=} opt_data Optional initial data array, typically ` +
        `from a\n` +
        ` * server response, or constructed directly in Javascript. The array ` +
        `is used\n` +
        ` * in place and becomes part of the constructed object. It is not ` +
        `cloned.\n` +
        ` * If no data is provided, the constructed object will be empty, but ` +
        `still\n` +
        ` * valid.\n` +
        ` * @extends {jspb.Message}\n` +
        ` * @constructor\n` +
        ` */\n` +
        `${classPrefix}${className} = function(opt_data) {\n`);
    let messageId = getMessageId(desc);
    messageId = messageId ? ("'" + messageId + "'")
                          : (isResponse(desc) ? "''" : "0");
    printer(
        `  jspb.Message.initialize(this, opt_data, ${messageId}, ${getPivot(desc)}, ` +
        `${repeatedFieldsArrayName(options, desc)}, ${oneofFieldsArrayName(options, desc)});\n`
        );
    className = getMessagePath(options, desc);
    printer(
        `};\n` +
        `goog.inherits(${className}, jspb.Message);\n` +
        `if (goog.DEBUG && !COMPILED) {\n` +
        // displayName overrides Function.prototype.displayName
        // http://google3/javascript/externs/es3.js?l=511
        `  /**\n` +
        `   * @public\n` +
        `   * @override\n` +
        `   */\n` +
        `  ${className}.displayName = '${className}';\n` +
        `}\n`);
  }

  generateClassFieldInfo(options, printer, desc) {
    if (hasRepeatedFields(options, desc)) {
      const className = getMessagePath(options, desc);
      printer(
          `/**\n` +
          ` * List of repeated fields within this message type.\n` +
          ` * @private {!Array<number>}\n` +
          ` * @const\n` +
          ` */\n` +
          `${className}${REPEATED_FIELD_ARRAY_NAME} = ${repeatedFieldNumberList(options, desc)};\n` +
          `\n`);
    }

    if (hasOneofFields(desc)) {
      const className = getMessagePath(options, desc);
      printer(
          `/**\n` +
          ` * Oneof group definitions for this message. Each group defines the ` +
          `field\n` +
          ` * numbers belonging to that group. When of these fields' value is ` +
          `set, all\n` +
          ` * other fields in the group are cleared. During deserialization, if ` +
          `multiple\n` +
          ` * fields are encountered for a group, only the last value seen will ` +
          `be kept.\n` +
          ` * @private {!Array<!Array<number>>}\n` +
          ` * @const\n` +
          ` */\n` +
          `${className}${ONEOF_GROUP_ARRAY_NAME} = ${oneofGroupList(desc)};\n` +
          `\n`);

      for (const oneof of desc.getOneofDeclList()) {
        if (ignoreOneof(oneof)) {
          continue;
        }
        this.generateOneofCaseDefinition(options, printer, oneof);
      }
    }
  }

  generateClassConstructorAndDeclareExtensionFieldInfo(options, printer, desc) {
    if (!namespaceOnly(desc)) {
      this.generateClassConstructor(options, printer, desc);
      if (isExtendable(desc) && desc.getFullName() != "google.protobuf.bridge.MessageSet") {
        this.generateClassExtensionFieldInfo(options, printer, desc);
      }
    }
    for (const d of desc.getNestedTypeList()) {
      if (!ignoreMessage(d)) {
        this.generateClassConstructorAndDeclareExtensionFieldInfo(
            options, printer, d);
      }
    }
  }

  generateOneofCaseDefinition(options, printer, oneof) {
    const className = getMessagePath(options, oneof.getContainingType());

    printer(
        `/**\n` +
        ` * @enum {number}\n` +
        ` */\n` +
        `${className}.${JSOneofName(oneof)}Case = {\n` +
        `  ${toEnumCase(oneof.getName())}_NOT_SET: 0`);

    for (const field of oneof.getFieldList()) {
      if (ignoreField(field)) {
        continue;
      }

      printer(
          `,\n` +
          `  ${toEnumCase(field.getName())}: ${JSFieldIndex(field)}`);
    }

    printer(
        `\n` +
        `};\n` +
        `\n` +
        `/**\n` +
        ` * @return {${className}.${JSOneofName(oneof)}Case}\n` +
        ` */\n` +
        `${className}.prototype.get${JSOneofName(oneof)}Case = function() {\n` +
        `  return /** @type {${className}.${JSOneofName(oneof)}Case} */(jspb.Message.` +
        `computeOneofCase(this, ${className}.oneofGroups_[${JSOneofIndex(oneof)}]));\n` +
        `};\n` +
        `\n`);
  }

  generateClassToObject(options, printer, desc) {
    const className = getMessagePath(options, desc);

    printer(
        `\n` +
        `\n` +
        `if (jspb.Message.GENERATE_TO_OBJECT) {\n` +
        `/**\n` +
        ` * Creates an object representation of this proto.\n` +
        ` * Field names that are reserved in JavaScript and will be renamed to ` +
        `pb_name.\n` +
        ` * Optional fields that are not set will be set to undefined.\n` +
        ` * To access a reserved field use, foo.pb_<name>, eg, foo.pb_default.\n` +
        ` * For the list of reserved names please see:\n` +
        ` *     net/proto2/compiler/js/internal/generator.cc#kKeyword.\n` +
        ` * @param {boolean=} opt_includeInstance Deprecated. whether to include ` +
        `the\n` +
        ` *     JSPB instance for transitional soy proto support:\n` +
        ` *     http://goto/soy-param-migration\n` +
        ` * @return {!Object}\n` +
        ` */\n` +
        `${className}.prototype.toObject = function(opt_includeInstance) {\n` +
        `  return ${className}.toObject(opt_includeInstance, this);\n` +
        `};\n` +
        `\n` +
        `\n` +
        `/**\n` +
        ` * Static version of the {@see toObject} method.\n` +
        ` * @param {boolean|undefined} includeInstance Deprecated. Whether to ` +
        `include\n` +
        ` *     the JSPB instance for transitional soy proto support:\n` +
        ` *     http://goto/soy-param-migration\n` +
        ` * @param {!${className}} msg The msg instance to transform.\n` +
        ` * @return {!Object}\n` +
        ` * @suppress {unusedLocalVariables} f is only used for nested messages\n` +
        ` */\n` +
        `${className}.toObject = function(includeInstance, msg) {\n` +
        `  var f, obj = {`);

    let first = true;
    for (const field of desc.getFieldList()) {
      if (ignoreField(field)) {
        continue;
      }

      if (!first) {
        printer(`,\n    `);
      } else {
        printer(`\n    `);
        first = false;
      }

      this.generateClassFieldToObject(options, printer, field);
    }

    if (!first) {
      printer(`\n  };\n\n`);
    } else {
      printer(`\n\n  };\n\n`);
    }

    if (isExtendable(desc)) {
      const extObject = JSExtensionsObjectName(options, desc.getFile(), desc);
      printer(
          `  jspb.Message.toObjectExtension(/** @type {!jspb.Message} */ (msg), ` +
          `obj,\n` +
          `      ${extObject}, ${className}.prototype.getExtension,\n` +
          `      includeInstance);\n`);
    }

    printer(
        `  if (includeInstance) {\n` +
        `    obj.$jspbMessageInstance = msg;\n` +
        `  }\n` +
        `  return obj;\n` +
        `};\n` +
        `}\n` +
        `\n` +
        `\n`);
  }

  generateClassFieldToObject(options, printer, field) {
    printer(`${JSObjectFieldName(options, field)}: `);

    if (field.isMap()) {
      const valueField = mapFieldValue(field);
      // If the map values are of a message type, we must provide their static
      // toObject() method; otherwise we pass undefined for that argument.
      let valueToObject = "";
      if (valueField.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
        valueToObject =
            getMessagePath(options, valueField.getMessageType()) + ".toObject";
      } else {
        valueToObject = "undefined";
      }
      printer(
          `(f = msg.get${JSGetterName(options, field)}()) ? f.toObject(includeInstance, ${valueToObject}) ` +
          `: []`);
    } else if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
      // Message field.
      if (field.isRepeated()) {
        {
          printer(
              `jspb.Message.toObjectList(msg.get${JSGetterName(options, field)}(),\n` +
              `    ${submessageTypeRef(options, field)}.toObject, includeInstance)`);
        }
      } else {
        printer(
            `(f = msg.get${JSGetterName(options, field)}()) && ` +
            `${submessageTypeRef(options, field)}.toObject(includeInstance, f)`);
      }
    } else if (field.getType() == FieldDescriptor.Type.TYPE_BYTES) {
      // For bytes fields we want to always return the B64 data.
      printer(`msg.get${JSGetterName(options, field, "B64")}()`);
    } else {
      let useDefault = field.hasDefaultValue();

      if (field.getFile().getSyntax() == FileDescriptor.Syntax.SYNTAX_PROTO3 &&
          // Repeated fields get initialized to their default in the constructor
          // (why?), so we emit a plain getField() call for them.
          !field.isRepeated()) {
        // Proto3 puts all defaults (including implicit defaults) in toObject().
        // But for proto2 we leave the existing semantics unchanged: unset fields
        // without default are unset.
        useDefault = true;
      }

      // We don't implement this by calling the accessors, because the semantics
      // of the accessors are changing independently of the toObject() semantics.
      // We are migrating the accessors to return defaults instead of null, but
      // it may take longer to migrate toObject (or we might not want to do it at
      // all).  So we want to generate independent code.
      // The accessor for unset optional values without default should return
      // null. Those are converted to undefined in the generated object.
      if (!useDefault) {
        printer(`(f = `);
      }
      this.generateFieldValueExpression(printer, "msg", field, useDefault);
      if (!useDefault) {
        printer(`) == null ? undefined : f`);
      }
    }
  }

  generateClassRegistration(options, printer, desc) {
    // Register any extensions defined inside this message type.
    for (const extension of desc.getExtensionList()) {
      if (shouldGenerateExtension(extension)) {
        this.generateExtension(options, printer, extension);
      }
    }

  }

  generateClassFields(options, printer, desc) {
    for (const field of desc.getFieldList()) {
      if (!ignoreField(field)) {
        this.generateClassField(options, printer, field);
      }
    }
  }

  generateClassField(options, printer, field) {
    if (field.isMap()) {
      const keyField = mapFieldKey(field);
      const valueField = mapFieldValue(field);
      // Map field: special handling to instantiate the map object on demand.
      let keyType =
          JSFieldTypeAnnotation(options, keyField,
                                /* isSetterArgument = */ false,
                                /* forcePresent = */ true,
                                /* singularIfNotPacked = */ false);
      let valueType =
          JSFieldTypeAnnotation(options, valueField,
                                /* isSetterArgument = */ false,
                                /* forcePresent = */ true,
                                /* singularIfNotPacked = */ false);

      printer(
          `/**\n` +
          ` * ${fieldDefinition(options, field)}\n` +
          ` * @param {boolean=} opt_noLazyCreate Do not create the map if\n` +
          ` * empty, instead returning \`undefined\`\n` +
          ` * @return {!jspb.Map<${keyType},${valueType}>}\n` +
          ` */\n`);

      const className = getMessagePath(options, field.getContainingType());
      const getterName = "get" + JSGetterName(options, field);
      printer(
          `${className}.prototype.${getterName} = function(opt_noLazyCreate) {\n` +
          `  return /** @type {!jspb.Map<${keyType},${valueType}>} */ (\n`);
      printer(
          `      jspb.Message.getMapField(this, ${JSFieldIndex(field)}, opt_noLazyCreate`);

      if (valueField.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
        printer(
            `,\n` +
            `      ${getMessagePath(options, valueField.getMessageType())}`);
      } else {
        printer(
            `,\n` +
            `      null`);
      }

      printer(`));\n`);

      printer(
          `};\n` +
          `\n` +
          `\n`);
    } else if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
      // Message field: special handling in order to wrap the underlying data
      // array with a message object.

      printer(
          `/**\n` +
          ` * ${fieldDefinition(options, field)}\n` +
          `${fieldComments(field, "")}` +
          ` * @return {${JSFieldTypeAnnotation(options, field,
                                               /* isSetterArgument = */ false,
                                               /* forcePresent = */ false,
                                               /* singularIfNotPacked = */ false)}}\n` +
          ` */\n`);

      const className = getMessagePath(options, field.getContainingType());
      const getterName = "get" + JSGetterName(options, field);
      const wrapperClass = submessageTypeRef(options, field);
      printer(
          `${className}.prototype.${getterName} = function() {\n` +
          `  return /** @type{${JSFieldTypeAnnotation(options, field,
                                                      /* isSetterArgument = */ false,
                                                      /* forcePresent = */ false,
                                                      /* singularIfNotPacked = */ false)}} */ (\n` +
          `    jspb.Message.get${(field.isRepeated() ? "Repeated" : "")}WrapperField(this, ${wrapperClass}, ` +
          `${JSFieldIndex(field)}${(field.getLabel() == FieldDescriptor.Label.LABEL_REQUIRED ? ", 1" : "")}));\n` +
          `};\n` +
          `\n` +
          `\n`);

      const optionalType = JSFieldTypeAnnotation(options, field,
                                                 /* isSetterArgument = */ true,
                                                 /* forcePresent = */ false,
                                                 /* singularIfNotPacked = */ false);
      const setterName = "set" + JSGetterName(options, field);
      const oneofTag = (inRealOneof(field) ? "Oneof" : "");
      const repeatedTag = (field.isRepeated() ? "Repeated" : "");
      printer(
          `/**\n` +
          ` * @param {${optionalType}} value\n` +
          ` * @return {!${className}} returns this\n` +
          `*/\n` +
          `${className}.prototype.${setterName} = function(value) {\n` +
          `  return jspb.Message.set${oneofTag}${repeatedTag}WrapperField(`);

      const oneofGroup = (inRealOneof(field) ? (", " + JSOneofArray(options, field))
                                                    : "");
      printer(
          `this, ${JSFieldIndex(field)}${oneofGroup}, value);\n` +
          `};\n` +
          `\n` +
          `\n`);

      if (field.isRepeated()) {
        this.generateRepeatedMessageHelperMethods(options, printer, field);
      }

    } else {
      let untyped =
          false;

      // Simple (primitive) field, either singular or repeated.

      // TODO(b/26173701): Always use BYTES_DEFAULT for the getter return type;
      // at this point we "lie" to non-binary users and tell the return
      // type is always base64 string, pending a LSC to migrate to typed getters.
      let bytesMode =
          field.getType() == FieldDescriptor.Type.TYPE_BYTES && !options.has("binary")
              ? "B64"
              : "";
      let typedAnnotation =
          JSFieldTypeAnnotation(options, field,
                                /* isSetterArgument = */ false,
                                /* forcePresent = */ false,
                                /* singularIfNotPacked = */ false,
                                /* bytes_mode = */ bytesMode);
      if (untyped) {
        printer(
            `/**\n` +
            ` * @return {?} Raw field, untyped.\n` +
            ` */\n`);
      } else {
        printer(
            `/**\n` +
            ` * ${fieldDefinition(options, field)}\n` +
            `${fieldComments(field, bytesMode)}` +
            ` * @return {${typedAnnotation}}\n` +
            ` */\n`);
      }

      const className = getMessagePath(options, field.getContainingType());
      const getterName = "get" + JSGetterName(options, field);
      printer(`${className}.prototype.${getterName} = function() {\n`);

      if (untyped) {
        printer(`  return `);
      } else {
        printer(`  return /** @type {${typedAnnotation}} */ (`);
      }

      let useDefault = !returnsNullWhenUnset(options, field);

      // Raw fields with no default set should just return undefined.
      if (untyped && !field.hasDefaultValue()) {
        useDefault = false;
      }

      // Repeated fields get initialized to their default in the constructor
      // (why?), so we emit a plain getField() call for them.
      if (field.isRepeated()) {
        useDefault = false;
      }

      this.generateFieldValueExpression(printer, "this", field, useDefault);

      if (untyped) {
        printer(
            `;\n` +
            `};\n` +
            `\n` +
            `\n`);
      } else {
        printer(
            `);\n` +
            `};\n` +
            `\n` +
            `\n`);
      }

      if (field.getType() == FieldDescriptor.Type.TYPE_BYTES && !untyped) {
        generateBytesWrapper(options, printer, field, "B64");
        generateBytesWrapper(options, printer, field, "U8");
      }

      const optionalType = untyped ? "*"
                                   : JSFieldTypeAnnotation(options, field,
                                                           /* isSetterArgument = */ true,
                                                           /* forcePresent = */ false,
                                                           /* singularIfNotPacked = */ false);
      printer(
          `/**\n` +
          ` * @param {${optionalType}} value\n` +
          ` * @return {!${className}} returns this\n` +
          ` */\n`);

      if (field.getFile().getSyntax() == FileDescriptor.Syntax.SYNTAX_PROTO3 &&
          !field.isRepeated() && !field.isMap() &&
          !hasFieldPresence(options, field)) {
        // Proto3 non-repeated and non-map fields without presence use the
        // setProto3*Field function.
        const className = getMessagePath(options, field.getContainingType());
        const setterName = "set" + JSGetterName(options, field);
        printer(
            `${className}.prototype.${setterName} = function(value) {\n` +
            `  return jspb.Message.setProto3${JSTypeTag(field)}Field(this, ${JSFieldIndex(field)}, ` +
            `value);` +
            `\n` +
            `};\n` +
            `\n` +
            `\n`);
      } else {
        // Otherwise, use the regular setField function.
        const className = getMessagePath(options, field.getContainingType());
        const setterName = "set" + JSGetterName(options, field);
        const oneofTag = (inRealOneof(field) ? "Oneof" : "");
        printer(
            `${className}.prototype.${setterName} = function(value) {\n` +
            `  return jspb.Message.set${oneofTag}Field(this, ${JSFieldIndex(field)}`);

        const type = untyped ? "/** @type{string|number|boolean|Array|undefined} */(" : "";
        const typeClose = untyped ? ")" : "";
        const oneofGroup = (inRealOneof(field) ? (", " + JSOneofArray(options, field)) : "");
        const repeatedValueInit = (field.isRepeated() ? " || []" : "");
        printer(
            `${oneofGroup}, ${type}value${repeatedValueInit}${typeClose});\n` +
            `};\n` +
            `\n` +
            `\n`);
      }

      if (untyped) {
        const className = getMessagePath(options, field.getContainingType());
        printer(
            `/**\n` +
            ` * Clears the value.\n` +
            ` * @return {!${className}} returns this\n` +
            ` */\n`);
      }

      if (field.isRepeated()) {
        this.generateRepeatedPrimitiveHelperMethods(options, printer, field, untyped);
      }
    }

    // Generate clearFoo() method for map fields, repeated fields, and other
    // fields with presence.
    if (field.isMap()) {
      const className = getMessagePath(options, field.getContainingType());
      const clearerName = "clear" + JSGetterName(options, field);
      const getterName = "get" + JSGetterName(options, field);
      printer(
          `/**\n` +
          ` * Clears values from the map. The map will be non-null.\n` +
          ` * @return {!${className}} returns this\n` +
          ` */\n` +
          `${className}.prototype.${clearerName} = function() {\n` +
          `  this.${getterName}().clear();\n` +
          `  return this;` +
          `};\n` +
          `\n` +
          `\n`);
    } else if (field.isRepeated() ||
               (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE &&
                !field.isRequired())) {
      // Fields where we can delegate to the regular setter.
      const jsdoc = field.isRepeated()
          ? "Clears the list making it empty but non-null."
          : "Clears the message field making it undefined.";
      const className = getMessagePath(options, field.getContainingType());
      const clearerName = "clear" + JSGetterName(options, field);
      const setterName = "set" + JSGetterName(options, field);
      const clearedValue = (field.isRepeated() ? "[]" : "undefined");
      printer(
          `/**\n` +
          ` * ${jsdoc}\n` +
          ` * @return {!${className}} returns this\n` +
          ` */\n` +
          `${className}.prototype.${clearerName} = function() {\n` +
          `  return this.${setterName}(${clearedValue});\n` +
          `};\n` +
          `\n` +
          `\n`);
    } else if (hasFieldPresence(options, field)) {
      // Fields where we can't delegate to the regular setter because it doesn't
      // accept "undefined" as an argument.
      const className = getMessagePath(options, field.getContainingType());
      const clearerName = "clear" + JSGetterName(options, field);
      const maybeOneof = (inRealOneof(field) ? "Oneof" : "");
      const maybeOneofGroup = (inRealOneof(field)
                               ? (", " + JSOneofArray(options, field))
                               : "");
      printer(
          `/**\n` +
          ` * Clears the field making it undefined.\n` +
          ` * @return {!${className}} returns this\n` +
          ` */\n` +
          `${className}.prototype.${clearerName} = function() {\n` +
          `  return jspb.Message.set${maybeOneof}Field(this, ` +
              `${JSFieldIndex(field)}${maybeOneofGroup}, `);

      const clearedValue = (field.isRepeated() ? "[]" : "undefined");
      printer(
          `${clearedValue});\n` +
          `};\n` +
          `\n` +
          `\n`);
    }

    if (hasFieldPresence(options, field)) {
      const className = getMessagePath(options, field.getContainingType());
      const haserName = "has" + JSGetterName(options, field);
      printer(
          `/**\n` +
          ` * Returns whether this field is set.\n` +
          ` * @return {boolean}\n` +
          ` */\n` +
          `${className}.prototype.${haserName} = function() {\n` +
          `  return jspb.Message.getField(this, ${JSFieldIndex(field)}) != null;\n` +
          `};\n` +
          `\n` +
          `\n`);
    }
  }

  generateClassExtensionFieldInfo(options, printer, desc) {
    if (isExtendable(desc)) {
      const className = getMessagePath(options, desc);
      printer(
          `\n` +
          `/**\n` +
          ` * The extensions registered with this message class. This is a ` +
          `map of\n` +
          ` * extension field number to fieldInfo object.\n` +
          ` *\n` +
          ` * For example:\n` +
          ` *     { 123: {fieldIndex: 123, fieldName: {my_field_name: 0}, ` +
          `ctor: proto.example.MyMessage} }\n` +
          ` *\n` +
          ` * fieldName contains the JsCompiler renamed field name property ` +
          `so that it\n` +
          ` * works in OPTIMIZED mode.\n` +
          ` *\n` +
          ` * @type {!Object<number, jspb.ExtensionFieldInfo>}\n` +
          ` */\n` +
          `${className}.extensions = {};\n` +
          `\n`);

      printer(
          `\n` +
          `/**\n` +
          ` * The extensions registered with this message class. This is a ` +
          `map of\n` +
          ` * extension field number to fieldInfo object.\n` +
          ` *\n` +
          ` * For example:\n` +
          ` *     { 123: {fieldIndex: 123, fieldName: {my_field_name: 0}, ` +
          `ctor: proto.example.MyMessage} }\n` +
          ` *\n` +
          ` * fieldName contains the JsCompiler renamed field name property ` +
          `so that it\n` +
          ` * works in OPTIMIZED mode.\n` +
          ` *\n` +
          ` * @type {!Object<number, jspb.ExtensionFieldBinaryInfo>}\n` +
          ` */\n` +
          `${className}.extensionsBinary = {};\n` +
          `\n`);
    }
  }

  generateClassDeserializeBinary(options, printer, desc) {
    const className = getMessagePath(options, desc);

    printer(
        `/**\n` +
        ` * Deserializes binary data (in protobuf wire format).\n` +
        ` * @param {jspb.ByteSource} bytes The bytes to deserialize.\n` +
        ` * @return {!${className}}\n` +
        ` */\n` +
        `${className}.deserializeBinary = function(bytes) {\n` +
        `  var reader = new jspb.BinaryReader(bytes);\n` +
        `  var msg = new ${className};\n` +
        `  return ${className}.deserializeBinaryFromReader(msg, reader);\n` +
        `};\n` +
        `\n` +
        `\n` +
        `/**\n` +
        ` * Deserializes binary data (in protobuf wire format) from the\n` +
        ` * given reader into the given message object.\n` +
        ` * @param {!${className}} msg The message object to deserialize into.\n` +
        ` * @param {!jspb.BinaryReader} reader The BinaryReader to use.\n` +
        ` * @return {!${className}}\n` +
        ` */\n` +
        `${className}.deserializeBinaryFromReader = function(msg, reader) {\n` +
        `  while (reader.nextField()) {\n`);
      printer(
          `    if (reader.isEndGroup()) {\n` +
          `      break;\n` +
          `    }\n` +
          `    var field = reader.getFieldNumber();\n` +
          `    switch (field) {\n`);

      for (const field of desc.getFieldList()) {
        if (!ignoreField(field)) {
          this.generateClassDeserializeBinaryField(options, printer, field);
        }
      }

      printer(`    default:\n`);
      if (isExtendable(desc)) {
        const extObj = JSExtensionsObjectName(options, desc.getFile(), desc);
        printer(
            `      jspb.Message.readBinaryExtension(msg, reader,\n` +
            `        ${extObj}Binary,\n` +
            `        ${className}.prototype.getExtension,\n` +
            `        ${className}.prototype.setExtension);\n` +
            `      break;\n` +
            `    }\n`);
      } else {
        printer(
            `      reader.skipField();\n` +
            `      break;\n` +
            `    }\n`);
      }

    printer(
        `  }\n` +
        `  return msg;\n` +
        `};\n` +
        `\n` +
        `\n`);
  }

  generateClassDeserializeBinaryField(options, printer, field) {
    printer(`    case ${field.getNumber()}:\n`);

    if (field.isMap()) {
      const keyField = mapFieldKey(field);
      const valueField = mapFieldValue(field);
      printer(
          `      var value = msg.get${JSGetterName(options, field)}();\n` +
          `      reader.readMessage(value, function(message, reader) {\n`);

      const keyReaderFn = JSBinaryReaderMethodName(options, keyField);
      const valueReaderFn = JSBinaryReaderMethodName(options, valueField);
      printer(
          `        jspb.Map.deserializeBinary(message, reader, ` +
          `${keyReaderFn}, ${valueReaderFn}`);

      if (valueField.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
        printer(`, ${getMessagePath(options, valueField.getMessageType())}.deserializeBinaryFromReader`);
      } else {
        printer(`, null`);
      }
      printer(`, ${JSFieldDefault(keyField)}`);
      if (valueField.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
        printer(`, new ${getMessagePath(options, valueField.getMessageType())}()`);
      } else {
        printer(`, ${JSFieldDefault(valueField)}`);
      }
      printer(`);\n`);
      printer(`         });\n`);
    } else {
      if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
        const fieldClass = submessageTypeRef(options, field);
        const msgOrGroup = (field.getType() == FieldDescriptor.Type.TYPE_GROUP) ? "Group" : "Message";
        const groupField = (field.getType() == FieldDescriptor.Type.TYPE_GROUP)
            ? (field.getNumber().toString() + ", ")
            : "";
        printer(
            `      var value = new ${fieldClass};\n` +
            `      reader.read${msgOrGroup}(${groupField}value,` +
            `${fieldClass}.deserializeBinaryFromReader);\n`);
      } else {
        const fieldType = JSFieldTypeAnnotation(options, field, false, true,
                                                /* singularIfNotPacked */ true, "U8");
        const reader = JSBinaryReadWriteMethodName(field, /* isWriter = */ false);
        printer(
            `      var value = /** @type {${fieldType}} */ ` +
            `(reader.read${reader}());\n`);
      }

      if (field.isRepeated() && !field.isPacked()) {
        printer(
            `      msg.add${JSGetterName(options, field, "", /* dropList = */ true)}(value);\n`);
      } else {
        // Singular fields, and packed repeated fields, receive a |value| either
        // as the field's value or as the array of all the field's values; set
        // this as the field's value directly.
        printer(`      msg.set${JSGetterName(options, field)}(value);\n`);
      }
    }

    printer(`      break;\n`);
  }

  generateClassSerializeBinary(options, printer, desc) {
    const className = getMessagePath(options, desc);
    printer(
        `/**\n` +
        ` * Serializes the message to binary data (in protobuf wire format).\n` +
        ` * @return {!Uint8Array}\n` +
        ` */\n` +
        `${className}.prototype.serializeBinary = function() {\n` +
        `  var writer = new jspb.BinaryWriter();\n` +
        `  ${className}.serializeBinaryToWriter(this, writer);\n` +
        `  return writer.getResultBuffer();\n` +
        `};\n` +
        `\n` +
        `\n` +
        `/**\n` +
        ` * Serializes the given message to binary data (in protobuf wire\n` +
        ` * format), writing to the given BinaryWriter.\n` +
        ` * @param {!${className}} message\n` +
        ` * @param {!jspb.BinaryWriter} writer\n` +
        ` * @suppress {unusedLocalVariables} f is only used for nested messages\n` +
        ` */\n` +
        `${className}.serializeBinaryToWriter = function(message, ` +
        `writer) {\n` +
        `  var f = undefined;\n`);

    for (const field of desc.getFieldList()) {
      if (!ignoreField(field)) {
        this.generateClassSerializeBinaryField(options, printer, field);
      }
    }

    if (isExtendable(desc)) {
      const extObj = JSExtensionsObjectName(options, desc.getFile(), desc);
      printer(
          `  jspb.Message.serializeBinaryExtensions(message, writer,\n` +
          `    ${extObj}Binary, ${className}.prototype.getExtension);\n`);
    }

    printer(
        `};\n` +
        `\n` +
        `\n`);
  }

  generateClassSerializeBinaryField(options, printer, field) {
    if (hasFieldPresence(options, field) &&
        field.getCppType() != FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
      let typedAnnotation =
          JSFieldTypeAnnotation(options, field,
                                /* isSetterArgument = */ false,
                                /* forcePresent = */ false,
                                /* singularIfNotPacked = */ false,
                                /* bytesMode = */ "");
      printer(
          `  f = /** @type {${typedAnnotation}} */ ` +
          `(jspb.Message.getField(message, ${JSFieldIndex(field)}));\n`);
    } else {
      // No lazy creation for maps containers -- fastpath the empty case.
      const noLazy = field.isMap() ? "true" : "";
      printer(
          `  f = message.get${JSGetterName(options, field, "U8")}(${noLazy});\n`);
    }

    // Print an `if (condition)` statement that evaluates to true if the field
    // goes on the wire.
    if (field.isMap()) {
      printer(`  if (f && f.getLength() > 0) {\n`);
    } else if (field.isRepeated()) {
      printer(`  if (f.length > 0) {\n`);
    } else {
      if (hasFieldPresence(options, field)) {
        printer(`  if (f != null) {\n`);
      } else {
        // No field presence: serialize onto the wire only if value is
        // non-default.  Defaults are documented here:
        // https://goto.google.com/lhdfm
        switch (field.getCppType()) {
          case FieldDescriptor.CppType.CPPTYPE_INT32:
          case FieldDescriptor.CppType.CPPTYPE_INT64:
          case FieldDescriptor.CppType.CPPTYPE_UINT32:
          case FieldDescriptor.CppType.CPPTYPE_UINT64: {
            if (isIntegralFieldWithStringJSType(field)) {
              // We can use `parseInt` here even though it will not be precise for
              // 64-bit quantities because we are only testing for zero/nonzero,
              // and JS numbers (64-bit floating point values, i.e., doubles) are
              // integer-precise in the range that includes zero.
              printer(`  if (parseInt(f, 10) !== 0) {\n`);
            } else {
              printer(`  if (f !== 0) {\n`);
            }
            break;
          }

          case FieldDescriptor.CppType.CPPTYPE_ENUM:
          case FieldDescriptor.CppType.CPPTYPE_FLOAT:
          case FieldDescriptor.CppType.CPPTYPE_DOUBLE:
            printer(`  if (f !== 0.0) {\n`);
            break;
          case FieldDescriptor.CppType.CPPTYPE_BOOL:
            printer(`  if (f) {\n`);
            break;
          case FieldDescriptor.CppType.CPPTYPE_STRING:
            printer(`  if (f.length > 0) {\n`);
            break;
        }
      }
    }

    // Write the field on the wire.
    if (field.isMap()) {
      const keyField = mapFieldKey(field);
      const valueField = mapFieldValue(field);
      const index = field.getNumber();
      const keyWriterFn = JSBinaryWriterMethodName(options, keyField);
      const valueWriterFn = JSBinaryWriterMethodName(options, valueField);
      printer(
          `    f.serializeBinary(${index}, writer, ` +
          `${keyWriterFn}, ${valueWriterFn}`);

      if (valueField.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
        printer(`, ${getMessagePath(options, valueField.getMessageType())}.serializeBinaryToWriter`);
      }

      printer(`);\n`);
    } else {
      const index = field.getNumber();
      printer(
          `    writer.write${JSBinaryReadWriteMethodName(field, /* isWriter = */ true)}(\n` +
          `      ${index},\n` +
          `      f`);

      if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE &&
          !field.isMap()) {
        printer(
            `,\n` +
            `      ${submessageTypeRef(options, field)}.serializeBinaryToWriter\n`);
      } else {
        printer(`\n`);
      }

      printer(`    );\n`);
    }

    // Close the `if`.
    printer(`  }\n`);
  }

  // Generate definition for one enum.
  generateEnum(options, printer, enumdesc) {
    printer(
        `/**\n` +
        ` * @enum {number}\n` +
        ` */\n` +
        `${getEnumPathPrefix(options, enumdesc)}${enumdesc.getName()} = {\n`);

    let valid = enumdesc.getValueList().map((value) =>
      [toEnumCase(value.getName()), value]
    );
    if (enumdesc.getOptions() && enumdesc.getOptions().getAllowAlias()) {
      valid = [...new Map(valid)];
    }
    printer(valid.map(([name, value]) =>
      `  ${name}: ${value.getNumber()}`
    ).join(",\n"));

    printer(
        `\n` + 
        `};\n` +
        `\n`);
  }

  // Generate an extension definition.
  generateExtension(options, printer, field) {
    let extensionScope =
        (field.getExtensionScope()
             ? getMessagePath(options, field.getExtensionScope())
             : getNamespace(options, field.getFile()));

    const extensionObjectName = JSObjectFieldName(options, field);

    const nameInComment = extensionObjectName;
    const className = extensionScope;
    const extensionType = JSFieldTypeAnnotation(options, field,
                                                /* isSetterArgument = */ false,
                                                /* forcePresent = */ true,
                                                /* singularIfNotPacked = */ false);
    printer(
        `\n` +
        `/**\n` +
        ` * A tuple of {field number, class constructor} for the extension\n` +
        ` * field named \`${nameInComment}\`.\n` +
        ` * @type {!jspb.ExtensionFieldInfo<${extensionType}>}\n` +
        ` */\n` +
        `${className}.${extensionObjectName} = new jspb.ExtensionFieldInfo(\n`);

    const index = field.getNumber();
    const ctor = (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE
                      ? submessageTypeRef(options, field)
                      : "null");
    const toObject = (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE
                          ? (submessageTypeRef(options, field) + ".toObject")
                          : "null");
    printer(
        `    ${index},\n` +
        `    {${extensionObjectName}: 0},\n` +
        `    ${ctor},\n` +
        `     /** @type {?function((boolean|undefined),!jspb.Message=): ` +
        `!Object} */ (\n` +
        `         ${toObject}),\n` +
        `    ${(field.isRepeated() ? "1" : "0")});\n`);

    const extendName = JSExtensionsObjectName(options, field.getFile(), field.getContainingType());
    const binaryReaderFn = JSBinaryReaderMethodName(options, field);
    const binaryWriterFn = JSBinaryWriterMethodName(options, field);
    const binaryMessageSerializeFn = (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE)
                                         ? (submessageTypeRef(options, field) + ".serializeBinaryToWriter")
                                         : "undefined";
    const binaryMessageDeserializeFn = (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE)
                                           ? (submessageTypeRef(options, field) + ".deserializeBinaryFromReader")
                                           : "undefined";
    printer(
        `\n` +
        `${extendName}Binary[${index}] = new jspb.ExtensionFieldBinaryInfo(\n` +
        `    ${className}.${extensionObjectName},\n` +
        `    ${binaryReaderFn},\n` +
        `    ${binaryWriterFn},\n` +
        `    ${binaryMessageSerializeFn},\n` +
        `    ${binaryMessageDeserializeFn},\n`);

    const isPacked = (field.isPacked() ? "true" : "false");
    printer(`    ${isPacked});\n`);

    printer(
        `// This registers the extension field with the extended class, so that\n` +
        `// toObject() will function correctly.\n` +
        `${extendName}[${index}] = ${className}.${extensionObjectName};\n` +
        `\n`);
  }

  // Generate addFoo() method for repeated primitive fields.
  generateRepeatedPrimitiveHelperMethods(options, printer, field, untyped) {
    const className = getMessagePath(options, field.getContainingType());
    const adderName = "add" + JSGetterName(options, field, "",
                                           /* dropList = */ true);
    const optionalType = JSFieldTypeAnnotation(
                                               options, field,
                                               /* isSetterArgument = */ false,
                                               /* forcePresent = */ true,
                                               /* singularIfNotPacked = */ false,
                                               "",
                                               /* forceSingular = */ true)
    printer(
        `/**\n` +
        ` * @param {${optionalType}} value\n` +
        ` * @param {number=} opt_index\n` +
        ` * @return {!${className}} returns this\n` +
        ` */\n` +
        `${className}.prototype.${adderName} = function(value, opt_index) {\n` +
        `  return jspb.Message.addToRepeatedField(this, ` +
        `${JSFieldIndex(field)}`);

    const type = untyped ? "/** @type{string|number|boolean|!Uint8Array} */(" : "";
    const typeClose = untyped ? ")" : "";
    const oneofGroup = (inRealOneof(field) ? (", " + JSOneofArray(options, field)) : "");
    const repeatedValueInit = "";
    printer(
        `${oneofGroup}, ${type}value${repeatedValueInit}${typeClose}, ` +
        `opt_index);\n` +
        `};\n` +
        `\n` +
        `\n`);
  }

  // Generate addFoo() method for repeated message fields.
  generateRepeatedMessageHelperMethods(options, printer, field) {
    const optionalType = JSTypeName(options, field, "");
    const className = getMessagePath(options, field.getContainingType());
    const adderName = "add" + JSGetterName(options, field, "",
                                           /* dropList = */ true);
    const repeatedTag = (field.isRepeated() ? "Repeated" : "");
    printer(
        `/**\n` +
        ` * @param {!${optionalType}=} opt_value\n` +
        ` * @param {number=} opt_index\n` +
        ` * @return {!${optionalType}}\n` +
        ` */\n` +
        `${className}.prototype.${adderName} = function(opt_value, opt_index) {\n` +
        `  return jspb.Message.addTo${repeatedTag}WrapperField(`);

    const oneofGroup = (inRealOneof(field) ? (", " + JSOneofArray(options, field)) : "");
    const ctor = getMessagePath(options, field.getMessageType());
    printer(
        `this, ${JSFieldIndex(field)}${oneofGroup}, opt_value, ${ctor}, opt_index);\n` +
        `};\n` +
        `\n` +
        `\n`);
  }
}

// Sorted list of JavaScript keywords. These cannot be used as names. If they
// appear, we prefix them with "pb_".
const KEYWORD = [
  "abstract",   "boolean",      "break",      "byte",    "case",
  "catch",      "char",         "class",      "const",   "continue",
  "debugger",   "default",      "delete",     "do",      "double",
  "else",       "enum",         "export",     "extends", "false",
  "final",      "finally",      "float",      "for",     "function",
  "goto",       "if",           "implements", "import",  "in",
  "instanceof", "int",          "interface",  "long",    "native",
  "new",        "null",         "package",    "private", "protected",
  "public",     "return",       "short",      "static",  "super",
  "switch",     "synchronized", "this",       "throw",   "throws",
  "transient",  "try",          "typeof",     "var",     "void",
  "volatile",   "while",        "with",
];

function isReserved(ident) {
  return KEYWORD.includes(ident);
}

// Returns a copy of |filename| with any trailing ".protodevel" or ".proto
// suffix stripped.
function stripProto(filename) {
  let suffix = filename.endsWith(".protodevel") ? /\.protodevel$/ : /\.proto$/;
  return filename.replace(suffix, "");
}

// Given a filename like foo/bar/baz.proto, returns the corresponding JavaScript
// file foo/bar/baz.js.
function getJSFilename(options, filename) {
  return stripProto(filename) + getFileNameExtension(options);
}

// Given a filename like foo/bar/baz.proto, returns the root directory
// path ../../
function getRootPath(fromFilename, toFilename) {
  if (toFilename.startsWith("google/protobuf")) {
    // Well-known types (.proto files in the google/protobuf directory) are
    // assumed to come from the 'google-protobuf' npm package.  We may want to
    // generalize this exception later by letting others put generated code in
    // their own npm packages.
    return "google-protobuf/";
  }

  let slashes = fromFilename.match(/\//g);
  if (!slashes) {
    return "./";
  }
  let result = "";
  for (let i = 0; i < slashes.length; i++) {
    result += "../";
  }
  return result;
}

// Returns the alias we assign to the module of the given .proto filename
// when importing.
function moduleAlias(filename) {
  // This scheme could technically cause problems if a file includes any 2 of:
  //   foo/bar_baz.proto
  //   foo_bar_baz.proto
  //   foo_bar/baz.proto
  //
  // We'll worry about this problem if/when we actually see it.  This name isn't
  // exposed to users so we can change it later if we need to.
  const basename = stripProto(filename)
    .replace(/\-/g, '$')
    .replace(/\//g, '_')
    .replace(/\./g, '_');
  return basename + "_pb";
}

// Returns the fully normalized JavaScript namespace for the given
// file descriptor's package.
function getNamespace(options, file) {
  if (options.get("namespace_prefix")) {
    return options.get("namespace_prefix");
  } else if (file.getPackage()) {
    return "proto." + file.getPackage();
  } else {
    return "proto";
  }
}

// Returns the name of the message with a leading dot and taking into account
// nesting, for example ".OuterMessage.InnerMessage", or returns empty if
// descriptor is null. This function does not handle namespacing, only message
// nesting.
function getNestedMessageName(descriptor) {
  if (descriptor == null) {
    return "";
  }
  let result = descriptor.getFullName().replace(
      new RegExp('^' + descriptor.getFile().getPackage()), "");
  // Add a leading dot if one is not already present.
  if (result && result[0] != '.') {
    result = "." + result;
  }
  return result;
}

// Returns the path prefix for a message or enumeration that
// lives under the given file and containing type.
function getPrefix(options, fileDescriptor, containingType) {
  let prefix = getNamespace(options, fileDescriptor) +
               getNestedMessageName(containingType);
  if (prefix) {
    prefix += ".";
  }
  return prefix;
}

// Returns the fully normalized JavaScript path prefix for the given
// message descriptor.
function getMessagePathPrefix(options, descriptor) {
  return getPrefix(options, descriptor.getFile(), descriptor.getContainingType());
}

// Returns the fully normalized JavaScript path for the given
// message descriptor.
function getMessagePath(options, descriptor) {
  return getMessagePathPrefix(options, descriptor) + descriptor.getName();
}

// Returns the fully normalized JavaScript path prefix for the given
// enumeration descriptor.
function getEnumPathPrefix(options, enumDescriptor) {
  return getPrefix(options, enumDescriptor.getFile(),
                   enumDescriptor.getContainingType());
}

// Returns the fully normalized JavaScript path for the given
// enumeration descriptor.
function getEnumPath(options, enumDescriptor) {
  return getEnumPathPrefix(options, enumDescriptor) + enumDescriptor.getName();
}

function maybeCrossFileRef(options, fromFile, toMessage) {
  if ((options.get("import_style") == "commonjs" ||
       options.get("import_style") == "commonjs_strict") &&
      fromFile != toMessage.getFile()) {
    // Cross-file ref in CommonJS needs to use the module alias instead of
    // the global name.
    return moduleAlias(toMessage.getFile().getName()) +
           getNestedMessageName(toMessage.getContainingType()) + "." +
           toMessage.getName();
  } else {
    // Within a single file we use a full name.
    return getMessagePath(options, toMessage);
  }
}

function submessageTypeRef(options, field) {
  return maybeCrossFileRef(options, field.getFile(), field.getMessageType());
}

// - Object field name: LOWER_UNDERSCORE -> LOWER_CAMEL, except for group fields
// (UPPER_CAMEL -> LOWER_CAMEL), with "List" (or "Map") appended if appropriate,
// and with reserved words triggering a "pb_" prefix.
// - Getters/setters: LOWER_UNDERSCORE -> UPPER_CAMEL, except for group fields
// (use the name directly), then append "List" if appropriate, then append "$"
// if resulting name is equal to a reserved word.
// - Enums: just uppercase.

// Locale-independent version of ToLower that deals only with ASCII A-Z.
function toLowerASCII(c) {
  if (c >= 'A' && c <= 'Z') {
    return c.toLowerCase();
  } else {
    return c;
  }
}

function parseLowerUnderscore(input) {
  const words = [];
  let running = "";
  for (let i = 0; i < input.length; i++) {
    if (input[i] == '_') {
      if (running) {
        words.push(running);
        running = "";
      }
    } else {
      running += toLowerASCII(input[i]);
    }
  }
  if (running) {
    words.push(running);
  }
  return words;
}

function parseUpperCamel(input) {
  const words = [];
  let running = "";
  for (let i = 0; i < input.length; i++) {
    if (input[i] >= 'A' && input[i] <= 'Z' && running) {
      words.push(running);
      running = "";
    }
    running += toLowerASCII(input[i]);
  }
  if (running) {
    words.push(running);
  }
  return words;
}

function toLowerCamel(words) {
  let result = "";
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (i == 0 && (word[0] >= 'A' && word[0] <= 'Z')) {
      word = word[0].toLowerCase() + word.slice(1);
    } else if (i != 0 && (word[0] >= 'a' && word[0] <= 'z')) {
      word = word[0].toUpperCase() + word.slice(1);
    }
    result += word;
  }
  return result;
}

function toUpperCamel(words) {
  let result = "";
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (word[0] >= 'a' && word[0] <= 'z') {
      word = word[0].toUpperCase() + word.slice(1);
    }
    result += word;
  }
  return result;
}

// Uppercases the entire string, turning ValueName into
// VALUENAME.
function toEnumCase(input) {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    if ('a' <= input[i] && input[i] <= 'z') {
      result += input[i].toUpperCase();
    } else {
      result += input[i];
    }
  }
  return result;
}

// Returns the message/response ID, if set.
function getMessageId(desc) {
  return "";
}

function ignoreExtensionField(field) {
  // Exclude descriptor extensions from output "to avoid clutter" (from original
  // codegen).
  if (!field.isExtension()) return false;
  let file = field.getContainingType().getFile();
  return file.getName() == "net/proto2/proto/descriptor.proto" ||
         file.getName() == "google/protobuf/descriptor.proto";
}


// Used inside Google only -- do not remove.
function isResponse(desc) { return false; }

function ignoreField(field) {
  return ignoreExtensionField(field);
}


// Do we ignore this message type?
function ignoreMessage(d) {
  return d.getOptions() && d.getOptions().getMapEntry();
}

// Does JSPB ignore this entire oneof? True only if all fields are ignored.
function ignoreOneof(oneof) {
  if (oneof.isSynthetic()) return true;
  for (const field of oneof.getFieldList()) {
    if (!ignoreField(field)) {
      return false;
    }
  }
  return true;
}

function JSIdent(options, field, isUpperCamel, isMap, dropList) {
  let result = "";
  if (field.getType() == field.constructor.Type.TYPE_GROUP) {
    result = isUpperCamel
                 ? toUpperCamel(parseUpperCamel(field.getMessageType().getName()))
                 : toLowerCamel(parseUpperCamel(field.getMessageType().getName()));
  } else {
    result = isUpperCamel ? toUpperCamel(parseLowerUnderscore(field.getName()))
                          : toLowerCamel(parseLowerUnderscore(field.getName()));
  }
  if (isMap || field.isMap()) {
    // JSPB-style or proto3-style map.
    result += "Map";
  } else if (!dropList && field.isRepeated()) {
    // Repeated field.
    result += "List";
  }
  return result;
}

function JSObjectFieldName(options, field) {
  let name = JSIdent(options, field,
                     /* isUpperCamel = */ false,
                     /* isMap = */ false,
                     /* dropList = */ false);
  if (isReserved(name)) {
    name = "pb_" + name;
  }
  return name;
}

// Returns the field name as a capitalized portion of a getter/setter method
// name, e.g. MyField for .getMyField().
function JSGetterName(options, field, bytesMode, dropList = false) {
  let name = JSIdent(options, field,
                     /* isUpperCamel = */ true,
                     /* isMap = */ false, dropList);
  if (field.getType() == FieldDescriptor.Type.TYPE_BYTES) {
    if (bytesMode) {
      name += "_as" + bytesMode;
    }
  }
  if (name == "Extension" || name == "JsPbMessageId") {
    // Avoid conflicts with base-class names.
    name += "$";
  }
  return name;
}


function JSOneofName(oneof) {
  return toUpperCamel(parseLowerUnderscore(oneof.getName()));
}

// Returns the index corresponding to this field in the JSPB array (underlying
// data storage array).
function JSFieldIndex(field) {
  // Determine whether this field is a member of a group. Group fields are a bit
  // wonky: their "containing type" is a message type created just for the
  // group, and that type's parent type has a field with the group-message type
  // as its message type and TYPE_GROUP as its field type. For such fields, the
  // index we use is relative to the field number of the group submessage field.
  // For all other fields, we just use the field number.
  const containingType = field.getContainingType();
  const parentType = containingType.getContainingType();
  if (parentType) {
    for (const f of parentType.getFieldList()) {
      if (f.getType() == FieldDescriptor.Type.TYPE_GROUP &&
          f.getMessageType() == containingType) {
        return (field.getNumber() - f.getNumber()).toString();
      }
    }
  }
  return field.getNumber().toString();
}

function JSOneofIndex(oneof) {
  let index = -1;
  for (const o of oneof.getContainingType().getOneofDeclList()) {
    // If at least one field in this oneof is not JSPB-ignored, count the oneof.
    for (const f of o.getFieldList()) {
      if (!ignoreField(f)) {
        index++;
        break;  // inner loop
      }
    }
    if (o == oneof) {
      break;
    }
  }
  return index.toString();
}

function escapeJSString(input) {
  let result = "";

  for (let i = 0; i < input.length; i++) {
    switch (input[i]) {
      case '\'':
        result += "\\x27";
        break;
      case '"':
        result += "\\x22";
        break;
      case '<':
        result += "\\x3c";
        break;
      case '=':
        result += "\\x3d";
        break;
      case '>':
        result += "\\x3e";
        break;
      case '&':
        result += "\\x26";
        break;
      case '\b':
        result += "\\b";
        break;
      case '\t':
        result += "\\t";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\f':
        result += "\\f";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\\':
        result += "\\\\";
        break;
      default:
        if (input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x7e) {
          result += input[i];
        } else if (str.charCodeAt(i) >= 0x100) {
          result += `\\u${input.charCodeAt(i).toString(16).padStart(4, '0')}`;
        } else {
          result += `\\x${input.charCodeAt(i).toString(16).padStart(2, '0')}`;
        }
        break;
    }
  }

  return result;
}

function escapeBase64(input) {
  const ALPHABET =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";

  for (let i = 0; i < input.length; i += 3) {
    const value = (input.charCodeAt(i) << 16) | (((i + 1) < input.length) ? (input.charCodeAt(i + 1) << 8) : 0) |
                  (((i + 2) < input.length) ? (input.charCodeAt(i + 2) << 0) : 0);
    result += ALPHABET[(value >> 18) & 0x3f];
    result += ALPHABET[(value >> 12) & 0x3f];
    if ((i + 1) < input.length) {
      result += ALPHABET[(value >> 6) & 0x3f];
    } else {
      result += '=';
    }
    if ((i + 2) < input.length) {
      result += ALPHABET[(value >> 0) & 0x3f];
    } else {
      result += '=';
    }
  }

  return result;
}

// Post-process the result of .toPrecision(6) to *exactly* match the
// original codegen's formatting (which is just .toString() on java.lang.Double
// or java.lang.Float).
function postProcessFloat(result) {
  switch (result) {
    case "Infinity":
    case "-Infinity":
    case "NaN":
      return result;
  }

  // If scientific notation (e.g., "1e10"), (i) capitalize the "e", (ii)
  // ensure that the mantissa (portion prior to the "e") has at least one
  // fractional digit (after the decimal point), and (iii) strip any unnecessary
  // leading zeroes and/or '+' signs from the exponent.
  let expPos = result.indexOf('e');
  if (expPos != -1) {
    let mantissa = result.substring(0, expPos);
    let exponent = result.substring(expPos + 1);

    let fracPos = mantissa.indexOf('.');
    // Strip any trailing zeroes off the mantissa.
    while (mantissa.length > fracPos + 2 && mantissa.endsWith('0')) {
      mantissa = mantissa.slice(0, -1);
    }

    // Strip the sign off the exponent and store as |exp_neg|.
    let expNeg = false;
    if (exponent.startsWith('+')) {
      exponent = exponent.substring(1);
    } else if (exponent.startsWith('-')) {
      expNeg = true;
      exponent = exponent.substring(1);
    }

    return mantissa + "E" + (expNeg ? "-" : "") + exponent;
  }

  // Otherwise, this is an ordinary decimal number. Append ".0" if result has no
  // decimal/fractional part in order to match output of original codegen.
  let fracPos = result.indexOf('.');
  if (fracPos == -1) {
    result += ".0";
  } else {
    // Strip any trailing zeroes off the decimal/fractional part.
    while (result.length > fracPos + 2 && result.endsWith('0')) {
      result = result.slice(0, -1);
    }
  }

  return result;
}

function inRealOneof(field) {
  return field.getContainingOneof() &&
         !field.getContainingOneof().isSynthetic();
}

// Return true if this is an integral field that should be represented as string
// in JS.
function isIntegralFieldWithStringJSType(field) {
  switch (field.getCppType()) {
    case FieldDescriptor.CppType.CPPTYPE_INT64:
    case FieldDescriptor.CppType.CPPTYPE_UINT64:
      // The default value of JSType is JS_NORMAL, which behaves the same as
      // JS_NUMBER.
      return field.getOptions() && field.getOptions().getJstype() == FieldOptions.JSType.JS_STRING;
    default:
      return false;
  }
}

function maybeNumberString(field, orig) {
  return isIntegralFieldWithStringJSType(field) ? ("\"" + orig + "\"") : orig;
}

function JSFieldDefault(field) {
  if (field.isRepeated()) {
    return "[]";
  }

  const defaultValue = field.getDefaultValue();

  switch (field.getCppType()) {
    case FieldDescriptor.CppType.CPPTYPE_INT32:
      return maybeNumberString(field, defaultValue.toString());
    case FieldDescriptor.CppType.CPPTYPE_UINT32:
      // The original codegen is in Java, and Java protobufs store unsigned
      // integer values as signed integer values. In order to exactly match the
      // output, we need to reinterpret as base-2 signed. Ugh.
      return maybeNumberString(
          field,
          (defaultValue >= 2n ** 31n ? defaultValue - 2n ** 32n : defaultValue).toString());
    case FieldDescriptor.CppType.CPPTYPE_INT64:
      return maybeNumberString(field, defaultValue);
    case FieldDescriptor.CppType.CPPTYPE_UINT64:
      // See above note for uint32 -- reinterpreting as signed.
      return maybeNumberString(
          field,
          (defaultValue >= 2n ** 63n ? defaultValue - 2n ** 64n : defaultValue).toString());
    case FieldDescriptor.CppType.CPPTYPE_ENUM:
      return defaultValue.getNumber().toString();
    case FieldDescriptor.CppType.CPPTYPE_BOOL:
      return defaultValue ? "true" : "false";
    case FieldDescriptor.CppType.CPPTYPE_DOUBLE:
    case FieldDescriptor.CppType.CPPTYPE_FLOAT:
      return postProcessFloat(defaultValue.toPrecision(6));
    case FieldDescriptor.CppType.CPPTYPE_STRING:
      if (field.getType() == FieldDescriptor.Type.TYPE_STRING) {
        return "\"" + escapeJSString(defaultValue) + "\"";
      } else {  // Bytes
        return "\"" + escapeBase64(defaultValue) + "\"";
      }
    case FieldDescriptor.CppType.CPPTYPE_MESSAGE:
      return "null";
  }
  return "";
}

function protoTypeName(options, field) {
  switch (field.getType()) {
    case FieldDescriptor.Type.TYPE_BOOL:
      return "bool";
    case FieldDescriptor.Type.TYPE_INT32:
      return "int32";
    case FieldDescriptor.Type.TYPE_UINT32:
      return "uint32";
    case FieldDescriptor.Type.TYPE_SINT32:
      return "sint32";
    case FieldDescriptor.Type.TYPE_FIXED32:
      return "fixed32";
    case FieldDescriptor.Type.TYPE_SFIXED32:
      return "sfixed32";
    case FieldDescriptor.Type.TYPE_INT64:
      return "int64";
    case FieldDescriptor.Type.TYPE_UINT64:
      return "uint64";
    case FieldDescriptor.Type.TYPE_SINT64:
      return "sint64";
    case FieldDescriptor.Type.TYPE_FIXED64:
      return "fixed64";
    case FieldDescriptor.Type.TYPE_SFIXED64:
      return "sfixed64";
    case FieldDescriptor.Type.TYPE_FLOAT:
      return "float";
    case FieldDescriptor.Type.TYPE_DOUBLE:
      return "double";
    case FieldDescriptor.Type.TYPE_STRING:
      return "string";
    case FieldDescriptor.Type.TYPE_BYTES:
      return "bytes";
    case FieldDescriptor.Type.TYPE_GROUP:
      return getMessagePath(options, field.getMessageType());
    case FieldDescriptor.Type.TYPE_ENUM:
      return getEnumPath(options, field.getEnumType());
    case FieldDescriptor.Type.TYPE_MESSAGE:
      return getMessagePath(options, field.getMessageType());
    default:
      return "";
  }
}

function JSIntegerTypeName(field) {
  return isIntegralFieldWithStringJSType(field) ? "string" : "number";
}

function JSStringTypeName(options, field, bytesMode) {
  if (field.getType() == FieldDescriptor.Type.TYPE_BYTES) {
    switch (bytesMode) {
      case "":
        return "(string|Uint8Array)";
      case "B64":
        return "string";
      case "U8":
        return "Uint8Array";
    }
  }
  return "string";
}

function JSTypeName(options, field, bytesMode) {
  switch (field.getCppType()) {
    case FieldDescriptor.CppType.CPPTYPE_BOOL:
      return "boolean";
    case FieldDescriptor.CppType.CPPTYPE_INT32:
      return JSIntegerTypeName(field);
    case FieldDescriptor.CppType.CPPTYPE_INT64:
      return JSIntegerTypeName(field);
    case FieldDescriptor.CppType.CPPTYPE_UINT32:
      return JSIntegerTypeName(field);
    case FieldDescriptor.CppType.CPPTYPE_UINT64:
      return JSIntegerTypeName(field);
    case FieldDescriptor.CppType.CPPTYPE_FLOAT:
      return "number";
    case FieldDescriptor.CppType.CPPTYPE_DOUBLE:
      return "number";
    case FieldDescriptor.CppType.CPPTYPE_STRING:
      return JSStringTypeName(options, field, bytesMode);
    case FieldDescriptor.CppType.CPPTYPE_ENUM:
      return getEnumPath(options, field.getEnumType());
    case FieldDescriptor.CppType.CPPTYPE_MESSAGE:
      return getMessagePath(options, field.getMessageType());
    default:
      return "";
  }
}

// Used inside Google only -- do not remove.
function useBrokenPresenceSemantics(options, field) {
  return false;
}

// Returns true for fields that return "null" from accessors when they are
// unset. This should normally only be true for non-repeated submessages, but we
// have legacy users who relied on old behavior where accessors behaved this
// way.
function returnsNullWhenUnset(options, field) {
  if (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_MESSAGE &&
      field.isOptional()) {
    return true;
  }

  return useBrokenPresenceSemantics(options, field) && !field.isRepeated() &&
         !field.hasDefaultValue();
}

// In a sane world, this would be the same as ReturnsNullWhenUnset().  But in
// the status quo, some fields declare that they never return null/undefined
// even though they actually do:
//   * required fields
//   * optional enum fields
//   * proto3 primitive fields.
function declaredReturnTypeIsNullable(options, field) {
  if (field.isRequired() || field.getType() == FieldDescriptor.Type.TYPE_ENUM) {
    return false;
  }

  if (field.getFile().getSyntax() == FileDescriptor.Syntax.SYNTAX_PROTO3 &&
      field.getCppType() != FieldDescriptor.CppType.CPPTYPE_MESSAGE) {
    return false;
  }

  return returnsNullWhenUnset(options, field);
}

function setterAcceptsUndefined(options, field) {
  if (returnsNullWhenUnset(options, field)) {
    return true;
  }

  // Broken presence semantics always accepts undefined for setters.
  return useBrokenPresenceSemantics(options, field);
}

function setterAcceptsNull(options, field) {
  if (returnsNullWhenUnset(options, field)) {
    return true;
  }

  // With broken presence semantics, fields with defaults accept "null" for
  // setters, but other fields do not.  This is a strange quirk of the old
  // codegen.
  return useBrokenPresenceSemantics(options, field) &&
         field.hasDefaultValue();
}

// Returns types which are known to by non-nullable by default.
// The style guide requires that we omit "!" in this case.
function isPrimitive(type) {
  return type == "undefined" || type == "string" || type == "number" ||
         type == "boolean";
}

function JSFieldTypeAnnotation(options, field, isSetterArgument, forcePresent,
                               singularIfNotPacked, bytesMode = "",
                               forceSingular = false) {
  let jstype = JSTypeName(options, field, bytesMode);

  if (!forceSingular && field.isRepeated() &&
      (field.isPacked() || !singularIfNotPacked)) {
    if (field.getType() == FieldDescriptor.Type.TYPE_BYTES &&
        bytesMode == "") {
      jstype = "(Array<!Uint8Array>|Array<string>)";
    } else {
      if (!isPrimitive(jstype)) {
        jstype = "!" + jstype;
      }
      jstype = "Array<" + jstype + ">";
    }
  }

  let isNullOrUndefined = false;

  if (isSetterArgument) {
    if (setterAcceptsNull(options, field)) {
      jstype = "?" + jstype;
      isNullOrUndefined = true;
    }

    if (setterAcceptsUndefined(options, field)) {
      jstype += "|undefined";
      isNullOrUndefined = true;
    }
  } else if (forcePresent) {
    // Don't add null or undefined.
  } else {
    if (declaredReturnTypeIsNullable(options, field)) {
      jstype = "?" + jstype;
      isNullOrUndefined = true;
    }
  }

  if (!isNullOrUndefined && !isPrimitive(jstype)) {
    jstype = "!" + jstype;
  }

  return jstype;
}

function JSBinaryReaderMethodType(field) {
  let name = field.getTypeName();
  if (name[0] >= 'a' && name[0] <= 'z') {
    name = name[0].toUpperCase() + name.slice(1);
  }
  return isIntegralFieldWithStringJSType(field) ? (name + "String") : name;
}

function JSBinaryReadWriteMethodName(field, isWriter) {
  let name = JSBinaryReaderMethodType(field);
  if (field.isPacked()) {
    name = "Packed" + name;
  } else if (isWriter && field.isRepeated()) {
    name = "Repeated" + name;
  }
  return name;
}

function JSBinaryReaderMethodName(options, field) {
  return "jspb.BinaryReader.prototype.read" +
         JSBinaryReadWriteMethodName(field, /* isWriter = */ false);
}

function JSBinaryWriterMethodName(options, field) {
  if (field.getContainingType() &&
      field.getContainingType().getOptions() &&
      field.getContainingType().getOptions().getMessageSetWireFormat()) {
    return "jspb.BinaryWriter.prototype.writeMessageSet";
  }
  return "jspb.BinaryWriter.prototype.write" +
         JSBinaryReadWriteMethodName(field, /* isWriter = */ true);
}


function JSTypeTag(desc) {
  switch (desc.getType()) {
    case FieldDescriptor.Type.TYPE_DOUBLE:
    case FieldDescriptor.Type.TYPE_FLOAT:
      return "Float";
    case FieldDescriptor.Type.TYPE_INT32:
    case FieldDescriptor.Type.TYPE_UINT32:
    case FieldDescriptor.Type.TYPE_INT64:
    case FieldDescriptor.Type.TYPE_UINT64:
    case FieldDescriptor.Type.TYPE_FIXED32:
    case FieldDescriptor.Type.TYPE_FIXED64:
    case FieldDescriptor.Type.TYPE_SINT32:
    case FieldDescriptor.Type.TYPE_SINT64:
    case FieldDescriptor.Type.TYPE_SFIXED32:
    case FieldDescriptor.Type.TYPE_SFIXED64:
      if (isIntegralFieldWithStringJSType(desc)) {
        return "StringInt";
      } else {
        return "Int";
      }
    case FieldDescriptor.Type.TYPE_BOOL:
      return "Boolean";
    case FieldDescriptor.Type.TYPE_STRING:
      return "String";
    case FieldDescriptor.Type.TYPE_BYTES:
      return "Bytes";
    case FieldDescriptor.Type.TYPE_ENUM:
      return "Enum";
  }
  return "";
}


function hasRepeatedFields(options, desc) {
  for (const field of desc.getFieldList()) {
    if (field.isRepeated() && !field.isMap()) {
      return true;
    }
  }
  return false;
}

const REPEATED_FIELD_ARRAY_NAME = ".repeatedFields_";

function repeatedFieldsArrayName(options, desc) {
  return hasRepeatedFields(options, desc)
             ? (getMessagePath(options, desc) + REPEATED_FIELD_ARRAY_NAME)
             : "null";
}

function hasOneofFields(desc) {
  for (const field of desc.getFieldList()) {
    if (inRealOneof(field)) {
      return true;
    }
  }
  return false;
}

const ONEOF_GROUP_ARRAY_NAME = ".oneofGroups_";

function oneofFieldsArrayName(options, desc) {
  return hasOneofFields(desc)
             ? (getMessagePath(options, desc) + ONEOF_GROUP_ARRAY_NAME)
             : "null";
}

function repeatedFieldNumberList(options, desc) {
  const numbers = [];
  for (const field of desc.getFieldList()) {
    if (field.isRepeated() && !field.isMap()) {
      numbers.push(JSFieldIndex(field));
    }
  }
  return "[" + numbers.join(",") + "]";
}

function oneofGroupList(desc) {
  // List of arrays (one per oneof), each of which is a list of field indices
  const oneofEntries = [];
  for (const oneof of desc.getOneofDeclList()) {
    if (ignoreOneof(oneof)) {
      continue;
    }

    const oneofFields = [];
    for (const field of oneof.getFieldList()) {
      if (ignoreField(field)) {
        continue;
      }
      oneofFields.push(JSFieldIndex(field));
    }
    oneofEntries.push("[" + oneofFields.join(",") + "]");
  }
  return "[" + oneofEntries.join(",") + "]";
}

function JSOneofArray(options, field) {
  return oneofFieldsArrayName(options, field.getContainingType()) + "[" +
         JSOneofIndex(field.getContainingOneof()) + "]";
}

function relativeTypeName(field) {
  // For a field with an enum or message type, compute a name relative to the
  // path name of the message type containing this field.
  let package = field.getFile().getPackage();
  let containingType = field.getContainingType().getFullName() + ".";
  let type = (field.getCppType() == FieldDescriptor.CppType.CPPTYPE_ENUM)
                 ? field.getEnumType().getFullName()
                 : field.getMessageType().getFullName();

  // |prefix| is advanced as we find separators '.' past the common package
  // prefix that yield common prefixes in the containing type's name and this
  // type's name.
  let prefix = 0;
  for (let i = 0; i < type.length && i < containingType.length; i++) {
    if (type[i] != containingType[i]) {
      break;
    }
    if (type[i] == '.' && i >= package.length) {
      prefix = i + 1;
    }
  }

  return type.substring(prefix);
}

function JSExtensionsObjectName(options, fromFile, desc) {
  if (desc.getFullName() == "google.protobuf.bridge.MessageSet") {
    return "jspb.Message.messageSetExtensions";
  } else {
    return maybeCrossFileRef(options, fromFile, desc) + ".extensions";
  }
}

const MAP_KEY_FIELD = 1;
const MAP_VALUE_FIELD = 2;

function mapFieldKey(field) {
  return field.getMessageType().findFieldByNumber(MAP_KEY_FIELD);
}

function mapFieldValue(field) {
  return field.getMessageType().findFieldByNumber(MAP_VALUE_FIELD);
}

function fieldDefinition(options, field) {
  if (field.isMap()) {
    const keyField = mapFieldKey(field);
    const valueField = mapFieldValue(field);
    let keyType = protoTypeName(options, keyField);
    let valueType = "";
    if (valueField.getType() == FieldDescriptor.Type.TYPE_ENUM ||
        valueField.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
      valueType = relativeTypeName(valueField);
    } else {
      valueType = protoTypeName(options, valueField);
    }
    return `map<${keyType}, ${valueType}> ${field.getName()} = ${field.getNumber()};`;
  } else {
    let qualifier =
        field.isRepeated() ? "repeated"
                           : (field.isOptional() ? "optional" : "required");
    let type = "", name = "";
    if (field.getType() == FieldDescriptor.Type.TYPE_ENUM ||
        field.getType() == FieldDescriptor.Type.TYPE_MESSAGE) {
      type = relativeTypeName(field);
      name = field.getName();
    } else if (field.getType() == FieldDescriptor.Type.TYPE_GROUP) {
      type = "group";
      name = field.getMessageType().getName();
    } else {
      type = protoTypeName(options, field);
      name = field.getName();
    }
    return `${qualifier} ${type} ${name} = ${field.getNumber()};`;
  }
}

function fieldComments(field, bytesMode) {
  let comments = "";
  if (field.getType() == FieldDescriptor.Type.TYPE_BYTES && bytesMode == "U8") {
    comments +=
        " * Note that Uint8Array is not supported on all browsers.\n" +
        " * @see http://caniuse.com/Uint8Array\n";
  }
  return comments;
}

function shouldGenerateExtension(field) {
  return field.isExtension() && !ignoreField(field);
}

function hasExtensions(descOrFile) {
  for (const extension of descOrFile.getExtensionList()) {
    if (shouldGenerateExtension(extension)) {
      return true;
    }
  }
  if (descOrFile instanceof Descriptor) {
    for (const desc of descOrFile.getNestedTypeList()) {
      if (hasExtensions(desc)) {
        return true;
      }
    }
  } else {
    for (const desc of descOrFile.getMessageTypeList()) {
      if (hasExtensions(desc)) {
        return true;
      }
    }
  }
  return false;
}

function hasMap(options, desc) {
  for (const f of desc.getFieldList()) {
    if (f.isMap()) {
      return true;
    }
  }
  for (const d of desc.getNestedTypeList()) {
    if (hasMap(options, d)) {
      return true;
    }
  }
  return false;
}

function fileHasMap(options, desc) {
  for (const d of desc.getMessageTypeList()) {
    if (hasMap(options, d)) {
      return true;
    }
  }
  return false;
}

function isExtendable(desc) {
  return desc.getExtensionRangeList().length > 0;
}


// Returns the max index in the underlying data storage array beyond which the
// extension object is used.
function getPivot(desc) {
  const DEFAULT_PIVOT = 500;

  // Find the max field number
  let maxFieldNumber = 0;
  for (const field of desc.getFieldList()) {
    if (!ignoreField(field) &&
        field.getNumber() > maxFieldNumber) {
      maxFieldNumber = field.getNumber();
    }
  }

  let pivot = -1;
  if (isExtendable(desc) || (maxFieldNumber >= DEFAULT_PIVOT)) {
    pivot = ((maxFieldNumber + 1) < DEFAULT_PIVOT) ? (maxFieldNumber + 1)
                                                   : DEFAULT_PIVOT;
  }

  return pivot.toString();
}

// Whether this field represents presence.  For fields with presence, we
// generate extra methods (clearFoo() and hasFoo()) for this field.
function hasFieldPresence(options, field) {
  // This returns false for repeated fields and maps, but we still do
  // generate clearFoo() methods for these through a special case elsewhere.
  return field.hasPresence();
}

function findProvidesForOneOfEnum(options, oneof, provided) {
  let name = getMessagePath(options, oneof.getContainingType()) + "." +
             JSOneofName(oneof) + "Case";
  provided.add(name);
}

function findProvidesForOneOfEnums(options, printer, desc, provided) {
  if (hasOneofFields(desc)) {
    for (const oneof of desc.getOneofDeclList()) {
      if (ignoreOneof(oneof)) {
        continue;
      }
      findProvidesForOneOfEnum(options, oneof, provided);
    }
  }
}

function namespaceOnly(desc) {
  return false;
}

function generateBytesWrapper(options, printer, field, bytesMode) {
  let type =
      JSFieldTypeAnnotation(options, field,
                            /* isSetterArgument = */ false,
                            /* forcePresent = */ false,
                            /* singularIfNotPacked = */ false, bytesMode);
  
  const className = getMessagePath(options, field.getContainingType());
  printer(
      `/**\n` +
      ` * ${fieldDefinition(options, field)}\n` +
      `${fieldComments(field, bytesMode)}` +
      ` * This is a type-conversion wrapper around \`get${JSGetterName(options, field, "")}()\`\n` +
      ` * @return {${type}}\n` +
      ` */\n` +
      `${className}.prototype.get${JSGetterName(options, field, bytesMode)} = function() {\n` +
      `  return /** @type {${type}} */ (jspb.Message.bytes${field.isRepeated() ? "List" : ""}As${bytesMode}(\n` +
      `      this.get${JSGetterName(options, field, "")}()));\n` +
      `};\n` +
      `\n` +
      `\n`);
}

module.exports = { Generator };
