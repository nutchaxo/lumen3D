/*
 * IJMacro: the ImageJ 1.54p macro language (IJM) for JavaScript.
 *
 * Ported from ImageJ 1.54p ij.macro (Tokenizer, Program, Symbol, Variable, Interpreter,
 * MacroConstants and the built-in functions of Functions). ImageJ is in the public domain
 * (Wayne Rasband, National Institutes of Health). The architecture is ImageJ's own: a Tokenizer
 * turns the source into a token array plus a symbol table (Program), and the Interpreter walks
 * that array with recursive descent (getToken / putTokenBack), so every quirk of the language
 * (error texts and line numbers, number formatting, `print(2==2)`, loose syntax) is the real one.
 *
 * Runs unchanged in a Web Worker and under Node: no DOM, no network, no eval / new Function /
 * WebAssembly (strict CSP, and a macro must never reach the network).
 *
 * API
 *   IJMacro.run(source, { host, onLog, signal, sliceMs = 50, arg, fastPath = true, syncLoops = false, syncRecursion = false, abortFlag })
 *       -> Promise<{ ok, error: null | { message, line, lineText, excerpt, calledFrom, silent, dialogText }, aborted, exited, returnValue }>
 *     `silent`: ImageJ shows no error window for this error (the program had already run off its end),
 *     so a host must not either; otherwise `dialogText` is the window's text and `calledFrom` the lines of
 *     its "(called from line n)" stack, innermost first.
 *     The interpreter is a set of generators. A host built-in may return a Promise: the driver
 *     awaits it and resumes with its value. Every `sliceMs` of work (checked every 16 loop
 *     iterations / user-function calls) the driver yields to the event loop, so a worker stays
 *     responsive; `signal.aborted` is honoured ("Macro canceled") at once, also while a wait() or a
 *     host Promise is pending (the signal is passed to host.call as ctx.signal).
 *     fastPath:  statements that cannot suspend run in a generated plain-function twin of the interpreter (about 3x
 *                faster; see "Synchronous fast path"); false = generators everywhere.
 *     syncLoops: also run whole loops in the twin (fastest; a loop is then neither time-sliced nor abortable by signal).
 *     syncRecursion: also run recursive user functions whole in the twin (about 3x faster, but a recursion is then neither
 *                abortable nor sliced, and it overflows a worker's native stack near 550 levels instead of ImageJ's 1000).
 *     abortFlag: Int32Array (SharedArrayBuffer): non-zero stops a stretch that cannot yield; host.syncFunctions: Set of
 *                host built-in names ('getPixel', 'List.get') that never return a Promise.
 *   IJMacro.prepare(source) -> Prepared { program, macros: [{ name, start, line }], needsGlobals }   (MacroInstaller.install)
 *   IJMacro.run(prepared, { ..., entry: { start, name } })   start -1 = the var statements only, 0 = the whole set, > 0 = the
 *       block of a macro "Name" entry (Interpreter.runMacro); the var values of a Prepared persist between its runs.
 *   IJMacro.run(..., { readVars: [name] }) -> result.vars { name: { n } | { s } | { a } | null }, read after the run ends.
 *   IJMacro.pixelProgram(code, { host, onLog, signal, sliceMs }) -> Promise<{ ok, error } | { ok, hasX, hasA, hasD, hasGetPixel,
 *       needsDrive, set, get, runSync, runAsync, dispose }>   the per-pixel program of Process > Math > Macro (ImageMath.applyMacro,
 *       PC_START = 23); needsDrive = the code holds a loop: run each pixel with runAsync (sliced, stopped by the signal).
 *   IJMacro.analyze(source, { host, syncLoops, syncRecursion }) -> { statements: [{ line, class: 'twin'|'loop'|'gen' }], functions: { name: { suspends, loops, recursive } } }
 *   IJMacro.tokenize(source) -> Program { code, lineNumbers, table, hasVars, hasFunctions, ... }
 *   IJMacro.compile(source)  -> { program, macros: [labels], functions: [names], tokens: [{...}] }
 *   IJMacro.d2s(n, decimals) / d2s3(x, significantDigits, maxDigits) / numToString(x)
 *   IJMacro.BUILTINS         the dispatch table (see "Built-in dispatch" below)
 *   IJMacro.define(kind, id, fn, { suspends, sync })   plug a built-in in ('do' | 'num' | 'str' | 'arr' | 'variable').
 *     suspends: true | false | 'host' (default for a built-in defined here: 'host') | { subName: ... } | (pgm, tokenIndex, host) => bool
 *     sync:     an optional plain function (f) => value for the synchronous fast path (arguments through f.getArg$s() ...);
 *               without it a built-in declared not-suspending is run to completion from its generator (slower).
 *   IJMacro.K / IJMacro.NAME_OF    MacroConstants ids and id -> function name
 *
 * Built-in dispatch: a built-in parses its own arguments from the token stream, as in ImageJ's
 * Functions, so it is a function of the Functions object `f` (plain, or a generator that may
 * `yield promise`). IJMacro.BUILTINS has one Map per call site kind (do | num | str | arr | variable)
 * keyed by the MacroConstants id; an id without an entry stops the macro with "Function not
 * available in the browser: <name>". IJMacro.coverage() lists what is implemented and what is missing.
 *
 * Limits: user functions nest as deep as ImageJ's variable stack allows (1000 slots, then "Stack overflow"
 * with its line): every 32 levels the driver takes over the nesting (class Sub) so V8's stack never
 * runs out. A macro that asks for a string over 2^27 characters or an array over 2^24 elements ends
 * with "Out of memory" (ImageJ: a catchable OutOfMemoryError).
 *
 * host (all optional)
 *   host.call(name, args, ctx)        non-pure built-ins, may return a Promise
 *   host.showMessage(title, text)     IJ.showMessage / IJ.error (exit("msg"), requires); modal: a returned
 *                                     Promise pauses the macro
 *   host.showError(text)              the error window of a failed eval() / runMacro() (falls back to
 *                                     host.showMessage('Macro Error', text))
 *   host.printToWindow(title, text)   print("[Window]", ...)
 *   host.runMacroFile(path, arg)      runMacro("file")
 *   A throw or rejection of any hook becomes a macro error with its line.
 *   host.getVersion()                 ImageJ.VERSION override
 */
const IJMacro = (() => {
'use strict';

/* ======================================================================================
 * MacroConstants (generated from ij/macro/MacroConstants.java)
 * ==================================================================================== */
const K = {"TOK_SHIFT":12, "TOK_MASK":4095, "PLUS_PLUS":1, "MINUS_MINUS":2, "EQ":3, "NEQ":4, "GT":5, "GTE":6, "LT":7, "LTE":8, "PLUS_EQUAL":9, "MINUS_EQUAL":10, "MUL_EQUAL":11, "DIV_EQUAL":12, "LOGICAL_AND":13, "LOGICAL_OR":14, "SHIFT_RIGHT":15, "SHIFT_LEFT":16, "EOF":128, "WORD":129, "NUMBER":130, "NOP":131, "EOL":132, "STRING_CONSTANT":133, "PREDEFINED_FUNCTION":134, "NUMERIC_FUNCTION":135, "STRING_FUNCTION":136, "ARRAY_FUNCTION":137, "USER_FUNCTION":138, "ARRAY":139, "VARIABLE_FUNCTION":140, "MACRO":200, "VAR":201, "IF":202, "ELSE":203, "WHILE":204, "DO":205, "FOR":206, "FUNCTION":207, "RETURN":208, "TRUE":209, "FALSE":210, "PI":211, "NaN":212, "BREAK":213, "CONTINUE":214, "RUN":300, "INVERT":301, "SELECT":302, "WAIT":303, "BEEP":304, "RESET_MIN_MAX":305, "RESET_THRESHOLD":306, "PRINT":307, "WRITE":308, "DO_WAND":309, "SET_MIN_MAX":310, "SET_THRESHOLD":311, "SET_TOOL":312, "SET_FOREGROUND":313, "SET_BACKGROUND":314, "MAKE_LINE":315, "MAKE_OVAL":316, "MAKE_RECTANGLE":317, "DUMP":318, "MOVE_TO":319, "LINE_TO":320, "DRAW_LINE":321, "REQUIRES":322, "AUTO_UPDATE":323, "UPDATE_DISPLAY":324, "DRAW_STRING":325, "SET_PASTE_MODE":326, "DO_COMMAND":327, "SHOW_STATUS":328, "SHOW_PROGRESS":329, "SHOW_MESSAGE":330, "PUT_PIXEL":331, "SET_PIXEL":332, "SNAPSHOT":333, "RESET":334, "FILL":335, "SET_COLOR":336, "SET_LINE_WIDTH":337, "CHANGE_VALUES":338, "SELECT_IMAGE":339, "EXIT":340, "SET_LOCATION":341, "GET_CURSOR_LOC":342, "GET_LINE":343, "GET_VOXEL_SIZE":344, "GET_HISTOGRAM":345, "GET_STATISTICS":346, "GET_BOUNDING_RECT":347, "GET_LUT":348, "SET_LUT":349, "GET_COORDINATES":350, "SHOW_MESSAGE_WITH_CANCEL":351, "MAKE_SELECTION":352, "SET_RESULT":353, "UPDATE_RESULTS":354, "SET_BATCH_MODE":355, "SET_JUSTIFICATION":357, "SET_Z_COORDINATE":358, "GET_THRESHOLD":359, "GET_PIXEL_SIZE":360, "SETUP_UNDO":361, "SAVE_SETTINGS":362, "RESTORE_SETTINGS":363, "SET_KEY_DOWN":364, "OPEN":365, "SET_FONT":366, "GET_MIN_AND_MAX":367, "CLOSE":368, "SET_SLICE":369, "NEW_IMAGE":370, "SAVE_AS":371, "SAVE":372, "SET_AUTO_THRESHOLD":373, "RENAME":374, "GET_BOUNDS":375, "FILL_RECT":376, "GET_RAW_STATISTICS":377, "FLOOD_FILL":378, "RESTORE_PREVIOUS_TOOL":379, "SET_VOXEL_SIZE":380, "GET_LOCATION_AND_SIZE":381, "GET_DATE_AND_TIME":382, "SET_METADATA":383, "CALCULATOR":384, "SET_RGB_WEIGHTS":385, "MAKE_POLYGON":386, "SET_SELECTION_NAME":387, "DRAW_RECT":388, "DRAW_OVAL":389, "FILL_OVAL":390, "SET_OPTION":391, "SHOW_TEXT":392, "SET_SELECTION_LOC":393, "GET_DIMENSIONS":394, "WAIT_FOR_USER":395, "MAKE_POINT":396, "MAKE_TEXT":397, "MAKE_ELLIPSE":398, "GET_DISPLAYED_AREA":399, "TO_SCALED":400, "TO_UNSCALED":401, "MAKE_ARROW":402, "MAKE_ROTATED_RECT":403, "GET_PIXEL":1000, "ABS":1001, "COS":1002, "EXP":1003, "FLOOR":1004, "LOG":1005, "MAX_OF":1006, "MIN_OF":1007, "POW":1008, "ROUND":1009, "SIN":1010, "SQRT":1011, "TAN":1012, "GET_TIME":1013, "GET_WIDTH":1014, "GET_HEIGHT":1015, "RANDOM":1016, "GET_RESULT":1017, "GET_COUNT":1018, "GET_NUMBER":1019, "NIMAGES":1020, "NSLICES":1021, "LENGTH_OF":1022, "NRESULTS":1023, "GET_ID":1024, "BIT_DEPTH":1025, "SELECTION_TYPE":1026, "ATAN":1027, "IS_OPEN":1028, "IS_ACTIVE":1029, "INDEX_OF":1030, "LAST_INDEX_OF":1031, "CHAR_CODE_AT":1032, "GET_BOOLEAN":1033, "STARTS_WITH":1034, "ENDS_WITH":1035, "ATAN2":1036, "IS_NAN":1037, "GET_ZOOM":1038, "PARSE_INT":1039, "PARSE_FLOAT":1040, "IS_KEY_DOWN":1041, "GET_SLICE_NUMBER":1042, "SCREEN_WIDTH":1043, "SCREEN_HEIGHT":1044, "CALIBRATE":1045, "ASIN":1046, "ACOS":1047, "ROI_MANAGER":1048, "TOOL_ID":1049, "IS":1050, "GET_VALUE":1051, "STACK":1052, "MATCHES":1053, "GET_STRING_WIDTH":1054, "FIT":1055, "OVERLAY":1056, "SELECTION_CONTAINS":1057, "PLOT":1058, "MATH":1059, "D2S":2000, "TO_HEX":2001, "TO_BINARY":2002, "GET_TITLE":2003, "GET_STRING":2004, "SUBSTRING":2005, "FROM_CHAR_CODE":2006, "GET_INFO":2007, "GET_DIRECTORY":2008, "GET_ARGUMENT":2009, "GET_IMAGE_INFO":2010, "TO_LOWER_CASE":2011, "TO_UPPER_CASE":2012, "RUN_MACRO":2013, "EVAL":2014, "TO_STRING":2015, "REPLACE":2016, "DIALOG":2017, "GET_METADATA":2018, "FILE":2019, "SELECTION_NAME":2020, "GET_VERSION":2021, "GET_RESULT_LABEL":2022, "CALL":2023, "STRING":2024, "EXT":2025, "EXEC":2026, "LIST":2027, "DEBUG":2028, "IJ_CALL":2029, "GET_RESULT_STRING":2030, "GET_DIR":2031, "TRIM":2032, "CHARAT":2033, "GET_PROFILE":3000, "NEW_ARRAY":3001, "SPLIT":3002, "GET_FILE_LIST":3003, "GET_FONT_LIST":3004, "NEW_MENU":3005, "GET_LIST":3006, "ARRAY_FUNC":3007, "TABLE":4000, "ROI":4001, "ROI_MANAGER2":4002, "PROPERTY":4003, "IMAGE":4004, "COLOR":4005};
/* A property read on K is a dictionary lookup (257 properties): the interpreter reads these module constants instead
 * (3x on a hot loop). K_<NAME> === K.<NAME>; tests/js/test_ijm_sync_twin.mjs fails on a K.<NAME> read in the code. */
const K_ABS = K.ABS,
  K_ACOS = K.ACOS,
  K_ARRAY_FUNC = K.ARRAY_FUNC,
  K_ASIN = K.ASIN,
  K_ATAN = K.ATAN,
  K_ATAN2 = K.ATAN2,
  K_AUTO_UPDATE = K.AUTO_UPDATE,
  K_BEEP = K.BEEP,
  K_BIT_DEPTH = K.BIT_DEPTH,
  K_BREAK = K.BREAK,
  K_CALCULATOR = K.CALCULATOR,
  K_CALIBRATE = K.CALIBRATE,
  K_CALL = K.CALL,
  K_CHANGE_VALUES = K.CHANGE_VALUES,
  K_CHARAT = K.CHARAT,
  K_CHAR_CODE_AT = K.CHAR_CODE_AT,
  K_CLOSE = K.CLOSE,
  K_COLOR = K.COLOR,
  K_CONTINUE = K.CONTINUE,
  K_COS = K.COS,
  K_D2S = K.D2S,
  K_DEBUG = K.DEBUG,
  K_DIALOG = K.DIALOG,
  K_DIV_EQUAL = K.DIV_EQUAL,
  K_DO = K.DO,
  K_DO_COMMAND = K.DO_COMMAND,
  K_DO_WAND = K.DO_WAND,
  K_DRAW_LINE = K.DRAW_LINE,
  K_DRAW_OVAL = K.DRAW_OVAL,
  K_DRAW_RECT = K.DRAW_RECT,
  K_DRAW_STRING = K.DRAW_STRING,
  K_DUMP = K.DUMP,
  K_ELSE = K.ELSE,
  K_ENDS_WITH = K.ENDS_WITH,
  K_EQ = K.EQ,
  K_EVAL = K.EVAL,
  K_EXEC = K.EXEC,
  K_EXIT = K.EXIT,
  K_EXP = K.EXP,
  K_EXT = K.EXT,
  K_FALSE = K.FALSE,
  K_FILE = K.FILE,
  K_FILL = K.FILL,
  K_FILL_OVAL = K.FILL_OVAL,
  K_FILL_RECT = K.FILL_RECT,
  K_FIT = K.FIT,
  K_FLOOD_FILL = K.FLOOD_FILL,
  K_FLOOR = K.FLOOR,
  K_FOR = K.FOR,
  K_FROM_CHAR_CODE = K.FROM_CHAR_CODE,
  K_FUNCTION = K.FUNCTION,
  K_GET_ARGUMENT = K.GET_ARGUMENT,
  K_GET_BOOLEAN = K.GET_BOOLEAN,
  K_GET_BOUNDING_RECT = K.GET_BOUNDING_RECT,
  K_GET_BOUNDS = K.GET_BOUNDS,
  K_GET_COORDINATES = K.GET_COORDINATES,
  K_GET_COUNT = K.GET_COUNT,
  K_GET_CURSOR_LOC = K.GET_CURSOR_LOC,
  K_GET_DATE_AND_TIME = K.GET_DATE_AND_TIME,
  K_GET_DIMENSIONS = K.GET_DIMENSIONS,
  K_GET_DIR = K.GET_DIR,
  K_GET_DIRECTORY = K.GET_DIRECTORY,
  K_GET_DISPLAYED_AREA = K.GET_DISPLAYED_AREA,
  K_GET_FILE_LIST = K.GET_FILE_LIST,
  K_GET_FONT_LIST = K.GET_FONT_LIST,
  K_GET_HEIGHT = K.GET_HEIGHT,
  K_GET_HISTOGRAM = K.GET_HISTOGRAM,
  K_GET_ID = K.GET_ID,
  K_GET_IMAGE_INFO = K.GET_IMAGE_INFO,
  K_GET_INFO = K.GET_INFO,
  K_GET_LINE = K.GET_LINE,
  K_GET_LIST = K.GET_LIST,
  K_GET_LOCATION_AND_SIZE = K.GET_LOCATION_AND_SIZE,
  K_GET_LUT = K.GET_LUT,
  K_GET_METADATA = K.GET_METADATA,
  K_GET_MIN_AND_MAX = K.GET_MIN_AND_MAX,
  K_GET_NUMBER = K.GET_NUMBER,
  K_GET_PIXEL = K.GET_PIXEL,
  K_GET_PIXEL_SIZE = K.GET_PIXEL_SIZE,
  K_GET_PROFILE = K.GET_PROFILE,
  K_GET_RAW_STATISTICS = K.GET_RAW_STATISTICS,
  K_GET_RESULT = K.GET_RESULT,
  K_GET_RESULT_LABEL = K.GET_RESULT_LABEL,
  K_GET_RESULT_STRING = K.GET_RESULT_STRING,
  K_GET_SLICE_NUMBER = K.GET_SLICE_NUMBER,
  K_GET_STATISTICS = K.GET_STATISTICS,
  K_GET_STRING = K.GET_STRING,
  K_GET_STRING_WIDTH = K.GET_STRING_WIDTH,
  K_GET_THRESHOLD = K.GET_THRESHOLD,
  K_GET_TIME = K.GET_TIME,
  K_GET_TITLE = K.GET_TITLE,
  K_GET_VALUE = K.GET_VALUE,
  K_GET_VERSION = K.GET_VERSION,
  K_GET_VOXEL_SIZE = K.GET_VOXEL_SIZE,
  K_GET_WIDTH = K.GET_WIDTH,
  K_GET_ZOOM = K.GET_ZOOM,
  K_GT = K.GT,
  K_GTE = K.GTE,
  K_IF = K.IF,
  K_IJ_CALL = K.IJ_CALL,
  K_IMAGE = K.IMAGE,
  K_INDEX_OF = K.INDEX_OF,
  K_INVERT = K.INVERT,
  K_IS = K.IS,
  K_IS_ACTIVE = K.IS_ACTIVE,
  K_IS_KEY_DOWN = K.IS_KEY_DOWN,
  K_IS_NAN = K.IS_NAN,
  K_IS_OPEN = K.IS_OPEN,
  K_LAST_INDEX_OF = K.LAST_INDEX_OF,
  K_LENGTH_OF = K.LENGTH_OF,
  K_LINE_TO = K.LINE_TO,
  K_LIST = K.LIST,
  K_LOG = K.LOG,
  K_LOGICAL_AND = K.LOGICAL_AND,
  K_LOGICAL_OR = K.LOGICAL_OR,
  K_LT = K.LT,
  K_LTE = K.LTE,
  K_MACRO = K.MACRO,
  K_MAKE_ARROW = K.MAKE_ARROW,
  K_MAKE_ELLIPSE = K.MAKE_ELLIPSE,
  K_MAKE_LINE = K.MAKE_LINE,
  K_MAKE_OVAL = K.MAKE_OVAL,
  K_MAKE_POINT = K.MAKE_POINT,
  K_MAKE_POLYGON = K.MAKE_POLYGON,
  K_MAKE_RECTANGLE = K.MAKE_RECTANGLE,
  K_MAKE_ROTATED_RECT = K.MAKE_ROTATED_RECT,
  K_MAKE_SELECTION = K.MAKE_SELECTION,
  K_MAKE_TEXT = K.MAKE_TEXT,
  K_MATCHES = K.MATCHES,
  K_MATH = K.MATH,
  K_MAX_OF = K.MAX_OF,
  K_MINUS_EQUAL = K.MINUS_EQUAL,
  K_MINUS_MINUS = K.MINUS_MINUS,
  K_MIN_OF = K.MIN_OF,
  K_MOVE_TO = K.MOVE_TO,
  K_MUL_EQUAL = K.MUL_EQUAL,
  K_NEQ = K.NEQ,
  K_NEW_ARRAY = K.NEW_ARRAY,
  K_NEW_IMAGE = K.NEW_IMAGE,
  K_NEW_MENU = K.NEW_MENU,
  K_NIMAGES = K.NIMAGES,
  K_NRESULTS = K.NRESULTS,
  K_NSLICES = K.NSLICES,
  K_NaN = K.NaN,
  K_OPEN = K.OPEN,
  K_OVERLAY = K.OVERLAY,
  K_PARSE_FLOAT = K.PARSE_FLOAT,
  K_PARSE_INT = K.PARSE_INT,
  K_PI = K.PI,
  K_PLOT = K.PLOT,
  K_PLUS_EQUAL = K.PLUS_EQUAL,
  K_PLUS_PLUS = K.PLUS_PLUS,
  K_POW = K.POW,
  K_PRINT = K.PRINT,
  K_PROPERTY = K.PROPERTY,
  K_PUT_PIXEL = K.PUT_PIXEL,
  K_RANDOM = K.RANDOM,
  K_RENAME = K.RENAME,
  K_REPLACE = K.REPLACE,
  K_REQUIRES = K.REQUIRES,
  K_RESET = K.RESET,
  K_RESET_MIN_MAX = K.RESET_MIN_MAX,
  K_RESET_THRESHOLD = K.RESET_THRESHOLD,
  K_RESTORE_PREVIOUS_TOOL = K.RESTORE_PREVIOUS_TOOL,
  K_RESTORE_SETTINGS = K.RESTORE_SETTINGS,
  K_RETURN = K.RETURN,
  K_ROI = K.ROI,
  K_ROI_MANAGER = K.ROI_MANAGER,
  K_ROI_MANAGER2 = K.ROI_MANAGER2,
  K_ROUND = K.ROUND,
  K_RUN = K.RUN,
  K_RUN_MACRO = K.RUN_MACRO,
  K_SAVE = K.SAVE,
  K_SAVE_AS = K.SAVE_AS,
  K_SAVE_SETTINGS = K.SAVE_SETTINGS,
  K_SCREEN_HEIGHT = K.SCREEN_HEIGHT,
  K_SCREEN_WIDTH = K.SCREEN_WIDTH,
  K_SELECT = K.SELECT,
  K_SELECTION_CONTAINS = K.SELECTION_CONTAINS,
  K_SELECTION_NAME = K.SELECTION_NAME,
  K_SELECTION_TYPE = K.SELECTION_TYPE,
  K_SELECT_IMAGE = K.SELECT_IMAGE,
  K_SETUP_UNDO = K.SETUP_UNDO,
  K_SET_AUTO_THRESHOLD = K.SET_AUTO_THRESHOLD,
  K_SET_BACKGROUND = K.SET_BACKGROUND,
  K_SET_BATCH_MODE = K.SET_BATCH_MODE,
  K_SET_COLOR = K.SET_COLOR,
  K_SET_FONT = K.SET_FONT,
  K_SET_FOREGROUND = K.SET_FOREGROUND,
  K_SET_JUSTIFICATION = K.SET_JUSTIFICATION,
  K_SET_KEY_DOWN = K.SET_KEY_DOWN,
  K_SET_LINE_WIDTH = K.SET_LINE_WIDTH,
  K_SET_LOCATION = K.SET_LOCATION,
  K_SET_LUT = K.SET_LUT,
  K_SET_METADATA = K.SET_METADATA,
  K_SET_MIN_MAX = K.SET_MIN_MAX,
  K_SET_OPTION = K.SET_OPTION,
  K_SET_PASTE_MODE = K.SET_PASTE_MODE,
  K_SET_PIXEL = K.SET_PIXEL,
  K_SET_RESULT = K.SET_RESULT,
  K_SET_RGB_WEIGHTS = K.SET_RGB_WEIGHTS,
  K_SET_SELECTION_LOC = K.SET_SELECTION_LOC,
  K_SET_SELECTION_NAME = K.SET_SELECTION_NAME,
  K_SET_SLICE = K.SET_SLICE,
  K_SET_THRESHOLD = K.SET_THRESHOLD,
  K_SET_TOOL = K.SET_TOOL,
  K_SET_VOXEL_SIZE = K.SET_VOXEL_SIZE,
  K_SET_Z_COORDINATE = K.SET_Z_COORDINATE,
  K_SHIFT_LEFT = K.SHIFT_LEFT,
  K_SHIFT_RIGHT = K.SHIFT_RIGHT,
  K_SHOW_MESSAGE = K.SHOW_MESSAGE,
  K_SHOW_MESSAGE_WITH_CANCEL = K.SHOW_MESSAGE_WITH_CANCEL,
  K_SHOW_PROGRESS = K.SHOW_PROGRESS,
  K_SHOW_STATUS = K.SHOW_STATUS,
  K_SHOW_TEXT = K.SHOW_TEXT,
  K_SIN = K.SIN,
  K_SNAPSHOT = K.SNAPSHOT,
  K_SPLIT = K.SPLIT,
  K_SQRT = K.SQRT,
  K_STACK = K.STACK,
  K_STARTS_WITH = K.STARTS_WITH,
  K_STRING = K.STRING,
  K_SUBSTRING = K.SUBSTRING,
  K_TABLE = K.TABLE,
  K_TAN = K.TAN,
  K_TOK_MASK = K.TOK_MASK,
  K_TOK_SHIFT = K.TOK_SHIFT,
  K_TOOL_ID = K.TOOL_ID,
  K_TO_BINARY = K.TO_BINARY,
  K_TO_HEX = K.TO_HEX,
  K_TO_LOWER_CASE = K.TO_LOWER_CASE,
  K_TO_SCALED = K.TO_SCALED,
  K_TO_STRING = K.TO_STRING,
  K_TO_UNSCALED = K.TO_UNSCALED,
  K_TO_UPPER_CASE = K.TO_UPPER_CASE,
  K_TRIM = K.TRIM,
  K_TRUE = K.TRUE,
  K_UPDATE_DISPLAY = K.UPDATE_DISPLAY,
  K_UPDATE_RESULTS = K.UPDATE_RESULTS,
  K_VAR = K.VAR,
  K_WAIT = K.WAIT,
  K_WAIT_FOR_USER = K.WAIT_FOR_USER,
  K_WHILE = K.WHILE,
  K_WRITE = K.WRITE;
const SYS_KEYWORDS = [["macro", K_MACRO], ["var", K_VAR], ["if", K_IF], ["else", K_ELSE], ["while", K_WHILE], ["do", K_DO], ["for", K_FOR], ["function", K_FUNCTION], ["return", K_RETURN], ["true", K_TRUE], ["false", K_FALSE], ["PI", K_PI], ["NaN", K_NaN], ["break", K_BREAK], ["continue", K_CONTINUE]];
const SYS_FUNCTIONS = [["run", K_RUN], ["invert", K_INVERT], ["selectWindow", K_SELECT], ["wait", K_WAIT], ["beep", K_BEEP], ["resetMinAndMax", K_RESET_MIN_MAX], ["resetThreshold", K_RESET_THRESHOLD], ["print", K_PRINT], ["write", K_WRITE], ["doWand", K_DO_WAND], ["setMinAndMax", K_SET_MIN_MAX], ["setThreshold", K_SET_THRESHOLD], ["setTool", K_SET_TOOL], ["setForegroundColor", K_SET_FOREGROUND], ["setBackgroundColor", K_SET_BACKGROUND], ["makeLine", K_MAKE_LINE], ["makeOval", K_MAKE_OVAL], ["makeRectangle", K_MAKE_RECTANGLE], ["dump", K_DUMP], ["moveTo", K_MOVE_TO], ["lineTo", K_LINE_TO], ["drawLine", K_DRAW_LINE], ["requires", K_REQUIRES], ["autoUpdate", K_AUTO_UPDATE], ["updateDisplay", K_UPDATE_DISPLAY], ["drawString", K_DRAW_STRING], ["setPasteMode", K_SET_PASTE_MODE], ["doCommand", K_DO_COMMAND], ["showStatus", K_SHOW_STATUS], ["showProgress", K_SHOW_PROGRESS], ["showMessage", K_SHOW_MESSAGE], ["putPixel", K_PUT_PIXEL], ["setPixel", K_SET_PIXEL], ["snapshot", K_SNAPSHOT], ["reset", K_RESET], ["fill", K_FILL], ["setColor", K_SET_COLOR], ["setLineWidth", K_SET_LINE_WIDTH], ["changeValues", K_CHANGE_VALUES], ["selectImage", K_SELECT_IMAGE], ["exit", K_EXIT], ["setLocation", K_SET_LOCATION], ["getCursorLoc", K_GET_CURSOR_LOC], ["getLine", K_GET_LINE], ["getVoxelSize", K_GET_VOXEL_SIZE], ["getHistogram", K_GET_HISTOGRAM], ["getStatistics", K_GET_STATISTICS], ["getBoundingRect", K_GET_BOUNDING_RECT], ["getLut", K_GET_LUT], ["setLut", K_SET_LUT], ["getSelectionCoordinates", K_GET_COORDINATES], ["showMessageWithCancel", K_SHOW_MESSAGE_WITH_CANCEL], ["makeSelection", K_MAKE_SELECTION], ["setResult", K_SET_RESULT], ["updateResults", K_UPDATE_RESULTS], ["setBatchMode", K_SET_BATCH_MODE], ["setJustification", K_SET_JUSTIFICATION], ["setZCoordinate", K_SET_Z_COORDINATE], ["getThreshold", K_GET_THRESHOLD], ["getPixelSize", K_GET_PIXEL_SIZE], ["setupUndo", K_SETUP_UNDO], ["saveSettings", K_SAVE_SETTINGS], ["restoreSettings", K_RESTORE_SETTINGS], ["setKeyDown", K_SET_KEY_DOWN], ["open", K_OPEN], ["setFont", K_SET_FONT], ["getMinAndMax", K_GET_MIN_AND_MAX], ["close", K_CLOSE], ["setSlice", K_SET_SLICE], ["newImage", K_NEW_IMAGE], ["saveAs", K_SAVE_AS], ["save", K_SAVE], ["setAutoThreshold", K_SET_AUTO_THRESHOLD], ["rename", K_RENAME], ["getSelectionBounds", K_GET_BOUNDS], ["fillRect", K_FILL_RECT], ["getRawStatistics", K_GET_RAW_STATISTICS], ["floodFill", K_FLOOD_FILL], ["restorePreviousTool", K_RESTORE_PREVIOUS_TOOL], ["setVoxelSize", K_SET_VOXEL_SIZE], ["getLocationAndSize", K_GET_LOCATION_AND_SIZE], ["getDateAndTime", K_GET_DATE_AND_TIME], ["setMetadata", K_SET_METADATA], ["imageCalculator", K_CALCULATOR], ["setRGBWeights", K_SET_RGB_WEIGHTS], ["makePolygon", K_MAKE_POLYGON], ["setSelectionName", K_SET_SELECTION_NAME], ["drawRect", K_DRAW_RECT], ["drawOval", K_DRAW_OVAL], ["fillOval", K_FILL_OVAL], ["setOption", K_SET_OPTION], ["showText", K_SHOW_TEXT], ["setSelectionLocation", K_SET_SELECTION_LOC], ["getDimensions", K_GET_DIMENSIONS], ["waitForUser", K_WAIT_FOR_USER], ["makePoint", K_MAKE_POINT], ["makeText", K_MAKE_TEXT], ["makeEllipse", K_MAKE_ELLIPSE], ["getDisplayedArea", K_GET_DISPLAYED_AREA], ["toScaled", K_TO_SCALED], ["toUnscaled", K_TO_UNSCALED], ["makeArrow", K_MAKE_ARROW], ["makeRotatedRectangle", K_MAKE_ROTATED_RECT]];
const SYS_NUMERICFUNCTIONS = [["getPixel", K_GET_PIXEL], ["abs", K_ABS], ["cos", K_COS], ["exp", K_EXP], ["floor", K_FLOOR], ["log", K_LOG], ["maxOf", K_MAX_OF], ["minOf", K_MIN_OF], ["pow", K_POW], ["round", K_ROUND], ["sin", K_SIN], ["sqrt", K_SQRT], ["tan", K_TAN], ["getTime", K_GET_TIME], ["getWidth", K_GET_WIDTH], ["getHeight", K_GET_HEIGHT], ["random", K_RANDOM], ["getResult", K_GET_RESULT], ["getResultsCount", K_GET_COUNT], ["getNumber", K_GET_NUMBER], ["nImages", K_NIMAGES], ["nSlices", K_NSLICES], ["lengthOf", K_LENGTH_OF], ["nResults", K_NRESULTS], ["getImageID", K_GET_ID], ["bitDepth", K_BIT_DEPTH], ["selectionType", K_SELECTION_TYPE], ["atan", K_ATAN], ["isOpen", K_IS_OPEN], ["isActive", K_IS_ACTIVE], ["indexOf", K_INDEX_OF], ["lastIndexOf", K_LAST_INDEX_OF], ["charCodeAt", K_CHAR_CODE_AT], ["getBoolean", K_GET_BOOLEAN], ["startsWith", K_STARTS_WITH], ["endsWith", K_ENDS_WITH], ["atan2", K_ATAN2], ["isNaN", K_IS_NAN], ["getZoom", K_GET_ZOOM], ["parseInt", K_PARSE_INT], ["parseFloat", K_PARSE_FLOAT], ["isKeyDown", K_IS_KEY_DOWN], ["getSliceNumber", K_GET_SLICE_NUMBER], ["screenWidth", K_SCREEN_WIDTH], ["screenHeight", K_SCREEN_HEIGHT], ["calibrate", K_CALIBRATE], ["asin", K_ASIN], ["acos", K_ACOS], ["roiManager", K_ROI_MANAGER], ["toolID", K_TOOL_ID], ["is", K_IS], ["getValue", K_GET_VALUE], ["Stack", K_STACK], ["matches", K_MATCHES], ["getStringWidth", K_GET_STRING_WIDTH], ["Fit", K_FIT], ["Overlay", K_OVERLAY], ["selectionContains", K_SELECTION_CONTAINS], ["Plot", K_PLOT], ["Math", K_MATH]];
const SYS_STRINGFUNCTIONS = [["d2s", K_D2S], ["toHex", K_TO_HEX], ["toBinary", K_TO_BINARY], ["getTitle", K_GET_TITLE], ["getString", K_GET_STRING], ["substring", K_SUBSTRING], ["fromCharCode", K_FROM_CHAR_CODE], ["getInfo", K_GET_INFO], ["getDirectory", K_GET_DIRECTORY], ["getArgument", K_GET_ARGUMENT], ["getImageInfo", K_GET_IMAGE_INFO], ["toLowerCase", K_TO_LOWER_CASE], ["toUpperCase", K_TO_UPPER_CASE], ["runMacro", K_RUN_MACRO], ["eval", K_EVAL], ["toString", K_TO_STRING], ["replace", K_REPLACE], ["Dialog", K_DIALOG], ["getMetadata", K_GET_METADATA], ["File", K_FILE], ["selectionName", K_SELECTION_NAME], ["getVersion", K_GET_VERSION], ["getResultLabel", K_GET_RESULT_LABEL], ["call", K_CALL], ["String", K_STRING], ["Ext", K_EXT], ["exec", K_EXEC], ["List", K_LIST], ["debug", K_DEBUG], ["IJ", K_IJ_CALL], ["getResultString", K_GET_RESULT_STRING], ["getDir", K_GET_DIR], ["trim", K_TRIM], ["charAt", K_CHARAT]];
const SYS_ARRAYFUNCTIONS = [["getProfile", K_GET_PROFILE], ["newArray", K_NEW_ARRAY], ["split", K_SPLIT], ["getFileList", K_GET_FILE_LIST], ["getFontList", K_GET_FONT_LIST], ["newMenu", K_NEW_MENU], ["getList", K_GET_LIST], ["Array", K_ARRAY_FUNC]];
const SYS_VARIABLEFUNCTIONS = [["Table", K_TABLE], ["Roi", K_ROI], ["RoiManager", K_ROI_MANAGER2], ["Property", K_PROPERTY], ["Image", K_IMAGE], ["Color", K_COLOR]];

const TOK_SHIFT = K_TOK_SHIFT, TOK_MASK = K_TOK_MASK;
const STACK_SIZE = 1000, MAX_ARGS = 20;
const IMAGEJ_VERSION = '1.54p';
const MACRO_CANCELED = 'Macro canceled';

const NAME_OF = {};   // id -> function name, for the "not available" error
for (const tbl of [SYS_FUNCTIONS, SYS_NUMERICFUNCTIONS, SYS_STRINGFUNCTIONS, SYS_ARRAYFUNCTIONS, SYS_VARIABLEFUNCTIONS])
  for (const [n, id] of tbl) NAME_OF[id] = n;

const C = (ch) => ch.charCodeAt(0);
const LP = C('('), RP = C(')'), LBRACE = C('{'), RBRACE = C('}'), LSQ = C('['), RSQ = C(']');
const SEMI = C(';'), COMMA = C(','), DOT = C('.'), EQUALS = C('=');
const { EOF, WORD, NUMBER, STRING_CONSTANT, PREDEFINED_FUNCTION, NUMERIC_FUNCTION, STRING_FUNCTION,
  ARRAY_FUNCTION, USER_FUNCTION, VARIABLE_FUNCTION } = K;

/* ======================================================================================
 * Control-flow exceptions. Plain objects (no stack capture): break / continue / return use them
 * exactly as ImageJ does (MacroException, ReturnException), and RuntimeException("Macro canceled")
 * is MacroCancel.
 * ==================================================================================== */
class MacroCancel { constructor(kind) { this.message = MACRO_CANCELED; this.kind = kind || 'cancel'; } }
class MacroException { constructor(type) { this.type = type; } }
class ReturnException { constructor() { this.value = 0; this.str = null; this.array = null; this.arraySize = 0; } }
/* A Java runtime exception that is not "Macro canceled" (what MacroProbe reports as `thrown`). */
class JavaException { constructor(message) { this.message = message; } }

/* ======================================================================================
 * Java semantics the interpreter relies on
 * ==================================================================================== */

/* (int) cast of a double: NaN -> 0, saturating, truncating. */
function toInt(x) {
  if (x !== x) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return x < 0 ? Math.ceil(x) : Math.floor(x);
}

function javaTrim(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) <= 32) a++;
  while (b > a && s.charCodeAt(b - 1) <= 32) b--;
  return a === 0 && b === s.length ? s : s.substring(a, b);
}

/* Double.toString(x) (JDK 19+ shortest representation). */
function javaDouble(x) {
  if (x !== x) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const a = Math.abs(x), sign = x < 0 ? '-' : '';
  if (a >= 1e-3 && a < 1e7) {
    let s = String(a);
    if (s.indexOf('.') < 0) s += '.0';
    return sign + s;
  }
  const sd = shortestDigits(a);
  let mant = sd.digits[0] + '.' + (sd.digits.length > 1 ? sd.digits.slice(1) : '0');
  return sign + mant + 'E' + sd.exp;
}

/* Double.parseDouble(s): the number, or null for a NumberFormatException. */
const JAVA_DEC = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
const JAVA_HEX = /^([+-]?)0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)[pP]([+-]?\d+)[fFdD]?$/;
function parseJavaDouble(str) {
  if (str === null || str === undefined) return null;
  const s = javaTrim(str);
  if (JAVA_DEC.test(s)) return Number(s.replace(/[fFdD]$/, '').replace(/^([+-]?)(NaN)$/, 'NaN'));
  const m = JAVA_HEX.exec(s);
  if (m && (m[2] + m[3]).length > 0) {
    const frac = m[3];
    const mant = parseInt((m[2] + frac) || '0', 16) / Math.pow(16, frac.length);
    return (m[1] === '-' ? -1 : 1) * mant * Math.pow(2, parseInt(m[4], 10));
  }
  return null;
}
/* Tools.parseDouble(s, default) */
function toolsParseDouble(s, def) {
  const v = parseJavaDouble(s);
  return v === null ? def : v;
}

/* String.compareToIgnoreCase */
function compareToIgnoreCase(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let c1 = a.charCodeAt(i), c2 = b.charCodeAt(i);
    if (c1 !== c2) {
      c1 = charUpper(c1); c2 = charUpper(c2);
      if (c1 !== c2) {
        c1 = charLower(c1); c2 = charLower(c2);
        if (c1 !== c2) return c1 - c2;
      }
    }
  }
  return a.length - b.length;
}
function charUpper(c) { const u = String.fromCharCode(c).toUpperCase(); return u.length === 1 ? u.charCodeAt(0) : c; }
function charLower(c) { const u = String.fromCharCode(c).toLowerCase(); return u.length === 1 ? u.charCodeAt(0) : c; }
/* String.compareTo */
function compareTo(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/* ======================================================================================
 * Number formatting: IJ.d2s over java.text.DecimalFormat (HALF_EVEN on the exact value; HALF_UP at 0 decimals)
 * ==================================================================================== */

/* Shortest round-trip digits of a > 0: { digits: '1234', exp } with a = d.ddd x 10^exp. */
function shortestDigits(a) {
  let t = a.toExponential();
  // Double.toString never stops at one digit: 4.9E-324 where the shortest repr is 5e-324 (only subnormals
  // are far enough from d.0 for the closest two-digit decimal to differ)
  if (a < 2.2250738585072014e-308 && t.indexOf('.') < 0) t = a.toExponential(1);
  const i = t.indexOf('e');
  let digits = t.slice(0, i).replace('.', '');
  if (digits.length > 1 && digits.endsWith('0') && t === a.toExponential(1)) digits = digits.replace(/0+$/, '') || '0';
  return { digits, exp: parseInt(t.slice(i + 1), 10) };
}

/* Exact comparison of the double a > 0 with N x 10^q (N a BigInt): -1, 0, 1. */
function compareExact(a, N, q) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, a);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const bexp = (hi >>> 20) & 0x7ff;
  let M = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let E;
  if (bexp === 0) E = -1074; else { M |= 1n << 52n; E = bexp - 1075; }
  let left = M, right = N;
  if (E >= 0) left <<= BigInt(E); else right <<= BigInt(-E);
  if (q >= 0) right *= 10n ** BigInt(q); else left *= 10n ** BigInt(-q);
  return left < right ? -1 : left > right ? 1 : 0;
}

/* Rounds the shortest digits of a to `keep` leading digits like java.text.DecimalFormat: a tie of the
 * shortest digits is decided on the exact binary value, and an exact tie goes to the even digit (HALF_EVEN)
 * or, `halfUp`, away from zero. IJ.d2s(n, 0) rounds ties away from zero (0.5 -> 1, 2.5 -> 3, -2.5 -> -3);
 * every other format keeps HALF_EVEN (d2s(0.125, 2) = 0.12). Returns the kept digits as a decimal
 * integer string (one digit longer on a carry, '' when everything is dropped). */
function roundShortest(a, sd, keep, halfUp) {
  const digits = sd.digits, L = digits.length;
  if (keep >= L) return digits + '0'.repeat(keep - L);
  if (keep < 0) return '';
  const t0 = digits.charCodeAt(keep) - 48;
  let up;
  if (t0 > 5) up = true;
  else if (t0 < 5) up = false;
  else if (L > keep + 1) up = true;
  else {
    const cmp = compareExact(a, BigInt(digits), sd.exp - (L - 1));
    if (cmp > 0) up = true;
    else if (cmp < 0) up = false;
    else up = halfUp || (keep > 0 && ((digits.charCodeAt(keep - 1) - 48) & 1) === 1);
  }
  let head = digits.slice(0, keep);
  if (!up) return head;
  if (keep === 0) return '1';
  const arr = head.split('');
  let i = keep - 1;
  while (i >= 0) {
    if (arr[i] === '9') { arr[i] = '0'; i--; } else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); break; }
  }
  head = arr.join('');
  return i < 0 ? '1' + head : head;
}

function isNegative(n) { return n < 0 || Object.is(n, -0); }

/* new DecimalFormat("0.00..").format(n) */
function formatFixed(n, dec) {
  const neg = isNegative(n), a = Math.abs(n);
  const sign = neg ? '-' : '';
  if (a === 0) return sign + (dec > 0 ? '0.' + '0'.repeat(dec) : '0');
  // up to 15 significant digits toFixed (exact value, ties up) and DecimalFormat (shortest digits, exactness
  // corrected) agree; beyond, DecimalFormat pads the shortest digits with zeros where toFixed shows the noise
  if (a < 1e15 && Math.floor(Math.log10(a)) + 2 + dec <= 15) {
    // an exact tie (x*10^dec = k + 1/2) needs x*2^(dec+1) integral and x*2^dec not; toFixed rounds it up
    const t = a * Math.pow(2, dec + 1);
    if (dec === 0 || !(Number.isInteger(t) && !Number.isInteger(t / 2))) return sign + a.toFixed(dec);
  }
  const sd = shortestDigits(a);
  const keep = sd.exp + 1 + dec;
  let I = roundShortest(a, sd, keep, dec === 0) || '0';
  I = I.replace(/^0+(?=.)/, '');
  if (dec === 0) return sign + I;
  if (I.length <= dec) I = '0'.repeat(dec - I.length + 1) + I;
  return sign + I.slice(0, I.length - dec) + '.' + I.slice(I.length - dec);
}

/* new DecimalFormat("0.00E0").format(n) with `dec` digits after the point */
function formatSci(n, dec) {
  const neg = isNegative(n), a = Math.abs(n);
  const sign = neg ? '-' : '';
  if (a === 0) return sign + '0' + (dec > 0 ? '.' + '0'.repeat(dec) : '') + 'E0';
  const sd = shortestDigits(a);
  let R = roundShortest(a, sd, dec + 1);
  let e = sd.exp;
  if (R.length > dec + 1) { R = R.slice(0, dec + 1); e++; }
  return sign + R[0] + (dec > 0 ? '.' + R.slice(1) : '') + 'E' + e;
}

/* IJ.d2s(n, decimalPlaces): negative decimalPlaces = scientific notation. */
function d2s(n, decimalPlaces) {
  if (n !== n) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (n === 3.4028234663852886e38) return '3.4e38';
  if (decimalPlaces < 0) {
    decimalPlaces = -decimalPlaces;
    if (decimalPlaces > 9) decimalPlaces = 9;
    return formatSci(n, decimalPlaces);
  }
  if (decimalPlaces > 9) decimalPlaces = 9;
  return formatFixed(n, decimalPlaces);
}

function log10(x) {
  const r = Math.log10(x), k = Math.round(r);
  return Math.pow(10, k) === x ? k : r;
}

/* IJ.d2s(x, significantDigits, maxDigits) */
function d2s3(x, significantDigits, maxDigits) {
  const l10 = log10(Math.abs(x));
  const roundErrorAtMax = 0.223 * Math.pow(10, -maxDigits);
  const magnitude = toInt(Math.ceil(l10 + roundErrorAtMax));
  let decimals = x === 0 ? 0 : maxDigits - magnitude;
  if (decimals < 0 || magnitude < significantDigits + 1 - maxDigits)
    return d2s(x, -significantDigits);
  if (decimals > significantDigits)
    decimals = Math.max(significantDigits, decimals - maxDigits + significantDigits);
  return d2s(x, decimals);
}

/* Interpreter.toString(double): integers without decimals, else 4 decimals (up to 9 digits),
 * trailing zeros stripped. `evaluating` = Java's `""+x`. */
function numToString(x, evaluating) {
  if (toInt(x) === x) return d2s(x, 0);
  if (evaluating) return javaDouble(x);
  let str = d2s3(x, 4, 9);
  while (str.endsWith('0') && str.indexOf('.') >= 0 && str.indexOf('E') < 0) str = str.substring(0, str.length - 1);
  if (str.endsWith('.')) str = str.substring(0, str.length - 1);
  return str;
}

/* ======================================================================================
 * java.io.StreamTokenizer, as configured by ij.macro.Tokenizer
 * ==================================================================================== */
const CT_WHITESPACE = 1, CT_DIGIT = 2, CT_ALPHA = 4, CT_QUOTE = 8, CT_COMMENT = 16;
const NEED_CHAR = 2147483647, SKIP_LF = 2147483646;
const TT_EOF = -1, TT_NUMBER = -2, TT_WORD = -3, TT_NOTHING = -4;

class StreamTokenizer {
  constructor(text) {
    this.text = text; this.pos = 0;
    this.ct = new Uint8Array(256);
    this.peekc = NEED_CHAR;
    this.pushedBack = false;
    this.lineno = 1;
    this.ttype = TT_NOTHING;
    this.sval = null;
    this.nval = 0;
    const ct = this.ct;
    for (let i = C('a'); i <= C('z'); i++) ct[i] |= CT_ALPHA;
    for (let i = C('A'); i <= C('Z'); i++) ct[i] |= CT_ALPHA;
    for (let i = 128 + 32; i <= 255; i++) ct[i] |= CT_ALPHA;
    for (let i = 0; i <= 32; i++) ct[i] = CT_WHITESPACE;
    ct[C('/')] |= CT_COMMENT;
    ct[C('"')] = CT_QUOTE;
    ct[C("'")] = CT_QUOTE;
    for (let i = C('0'); i <= C('9'); i++) ct[i] |= CT_DIGIT;
    ct[C('.')] |= CT_DIGIT;
    ct[C('-')] |= CT_DIGIT;
  }
  /* The configuration of ij.macro.Tokenizer.tokenize. */
  configureForMacros() {
    const ct = this.ct;
    ct[C('-')] = 0;                 // ordinaryChar('-')
    ct[C('/')] = 0;                 // ordinaryChar('/')
    ct[C('.')] = 0;                 // ordinaryChar('.')
    ct[C('_')] |= CT_ALPHA;         // wordChars('_', '_')
    for (let i = 128; i <= 255; i++) ct[i] = CT_WHITESPACE;   // whitespaceChars(128, 255)
    this.slashStarComments = true;
    this.slashSlashComments = true;
  }
  read() { return this.pos < this.text.length ? this.text.charCodeAt(this.pos++) : -1; }
  pushBack() { if (this.ttype !== TT_NOTHING) this.pushedBack = true; }

  nextToken() {
    if (this.pushedBack) { this.pushedBack = false; return this.ttype; }
    const ct = this.ct;
    this.sval = null;
    let c = this.peekc;
    if (c < 0) c = NEED_CHAR;
    if (c === SKIP_LF) {
      c = this.read();
      if (c < 0) return this.ttype = TT_EOF;
      if (c === 10) c = NEED_CHAR;
    }
    if (c === NEED_CHAR) {
      c = this.read();
      if (c < 0) return this.ttype = TT_EOF;
    }
    this.ttype = c;
    this.peekc = NEED_CHAR;
    let ctype = c < 256 ? ct[c] : CT_ALPHA;
    while ((ctype & CT_WHITESPACE) !== 0) {
      if (c === 13) {
        this.lineno++;
        c = this.read();
        if (c === 10) c = this.read();
      } else {
        if (c === 10) this.lineno++;
        c = this.read();
      }
      if (c < 0) return this.ttype = TT_EOF;
      ctype = c < 256 ? ct[c] : CT_ALPHA;
    }

    if ((ctype & CT_DIGIT) !== 0) {
      let v = 0, decexp = 0, seendot = 0;
      for (;;) {
        if (c === 46 && seendot === 0) seendot = 1;
        else if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); decexp += seendot; }
        else break;
        c = this.read();
      }
      this.peekc = c;
      if (decexp !== 0) {
        let denom = 10;
        decexp--;
        while (decexp > 0) { denom *= 10; decexp--; }
        v = v / denom;
      }
      this.nval = v;
      return this.ttype = TT_NUMBER;
    }

    if ((ctype & CT_ALPHA) !== 0) {
      let s = '';
      do {
        s += String.fromCharCode(c);
        c = this.read();
        ctype = c < 0 ? CT_WHITESPACE : c < 256 ? ct[c] : CT_ALPHA;
      } while ((ctype & (CT_ALPHA | CT_DIGIT)) !== 0);
      this.peekc = c;
      this.sval = s;
      return this.ttype = TT_WORD;
    }

    if ((ctype & CT_QUOTE) !== 0) {
      this.ttype = c;
      let s = '';
      let d = this.read();
      while (d >= 0 && d !== this.ttype && d !== 10 && d !== 13) {
        if (d === 92) {
          c = this.read();
          const first = c;
          if (c >= 48 && c <= 55) {
            c = c - 48;
            let c2 = this.read();
            if (c2 >= 48 && c2 <= 55) {
              c = (c << 3) + (c2 - 48);
              c2 = this.read();
              if (c2 >= 48 && c2 <= 55 && first <= 51) { c = (c << 3) + (c2 - 48); d = this.read(); }
              else d = c2;
            } else d = c2;
          } else {
            switch (c) {
              case 97: c = 0x7; break;
              case 98: c = 8; break;
              case 102: c = 0xC; break;
              case 110: c = 10; break;
              case 114: c = 13; break;
              case 116: c = 9; break;
              case 118: c = 0xB; break;
              default:
            }
            d = this.read();
          }
        } else {
          c = d;
          d = this.read();
        }
        s += String.fromCharCode(c);
      }
      this.peekc = d === this.ttype ? NEED_CHAR : d;
      this.sval = s;
      return this.ttype;
    }

    if (c === 47 && (this.slashSlashComments || this.slashStarComments)) {
      c = this.read();
      if (c === 42 && this.slashStarComments) {
        let prevc = 0;
        while ((c = this.read()) !== 47 || prevc !== 42) {
          if (c === 13) {
            this.lineno++;
            c = this.read();
            if (c === 10) c = this.read();
          } else if (c === 10) {
            this.lineno++;
            c = this.read();
          }
          if (c < 0) return this.ttype = TT_EOF;
          prevc = c;
        }
        return this.nextToken();
      } else if (c === 47 && this.slashSlashComments) {
        while ((c = this.read()) !== 10 && c !== 13 && c >= 0);
        this.peekc = c;
        return this.nextToken();
      } else if ((ct[47] & CT_COMMENT) !== 0) {
        while ((c = this.read()) !== 10 && c !== 13 && c >= 0);
        this.peekc = c;
        return this.nextToken();
      }
      this.peekc = c;
      return this.ttype = 47;
    }

    if ((ctype & CT_COMMENT) !== 0) {
      while ((c = this.read()) !== 10 && c !== 13 && c >= 0);
      this.peekc = c;
      return this.nextToken();
    }
    return this.ttype = c;
  }
}

/* ======================================================================================
 * Symbol, Program (token array + symbol table), Tokenizer
 * ==================================================================================== */
class Symbol_ {
  constructor(type, value, str) { this.type = type; this.value = value; this.str = str; }
}
const newWordSymbol = (token, str) => new Symbol_(token & 0xffff, 0, str);   // Symbol(int, String)
const newNumberSymbol = (value) => new Symbol_(0, value, null);              // Symbol(double)

function functionTypeOf(sym) {   // Symbol.getFunctionType
  const t = sym.type;
  if (t >= 300 && t < 1000) return PREDEFINED_FUNCTION;
  if (t >= 1000 && t < 2000) return NUMERIC_FUNCTION;
  if (t >= 2000 && t < 3000) return STRING_FUNCTION;
  if (t >= 3000 && t < 4000) return ARRAY_FUNCTION;
  if (t >= 4000 && t < 5000) return VARIABLE_FUNCTION;
  return 0;
}

const SYSTEM_TABLE = [];
const SYSTEM_INDEX = new Map();
for (const list of [SYS_KEYWORDS, SYS_FUNCTIONS, SYS_NUMERICFUNCTIONS, SYS_STRINGFUNCTIONS, SYS_ARRAYFUNCTIONS, SYS_VARIABLEFUNCTIONS])
  for (const [name, id] of list) {
    if (!SYSTEM_INDEX.has(name)) SYSTEM_INDEX.set(name, SYSTEM_TABLE.length);
    SYSTEM_TABLE.push(newWordSymbol(id, name));
  }

class Program {
  constructor() {
    this.pc = -1;
    this.stLoc = SYSTEM_TABLE.length - 1;
    this.symTabLoc = 0;
    this.table = SYSTEM_TABLE.slice();
    this.words = new Map();      // user words -> index (lookupWord finds the system table first)
    this.code = [];
    this.lineNumbers = [];
    this.globals = null;
    this.hasVars = false;
    this.hasFunctions = false;
    this.macroCount = 0;
  }
  addSymbol(sym) { this.stLoc++; this.table[this.stLoc] = sym; }
  addToken(tok, lineNumber) { this.pc++; this.code[this.pc] = tok; this.lineNumbers[this.pc] = lineNumber; }
  /* Program.lookupWord: the symbol of a word, or null. Sets symTabLoc. */
  lookupWord(str) {
    let i = SYSTEM_INDEX.get(str);
    if (i === undefined) i = this.words.get(str);
    if (i === undefined) return null;
    this.symTabLoc = i;
    return this.table[i];
  }
  getSize() { return this.pc; }

  decodeToken(token, address) {
    if (address === undefined) { address = token >> TOK_SHIFT; token = token & TOK_MASK; }
    let str;
    switch (token) {
      case WORD: case PREDEFINED_FUNCTION: case NUMERIC_FUNCTION: case STRING_FUNCTION:
      case ARRAY_FUNCTION: case VARIABLE_FUNCTION: case USER_FUNCTION:
        str = this.table[address].str;
        break;
      case STRING_CONSTANT:
        str = '"' + this.table[address].str + '"';
        break;
      case NUMBER: {
        const v = this.table[address].value;
        str = toInt(v) === v ? d2s(v, 0) : javaDouble(v);
        break;
      }
      case EOF:
        str = 'EOF';
        break;
      default:
        if (token < 32) {
          switch (token) {
            case K_PLUS_PLUS: str = '++'; break;
            case K_MINUS_MINUS: str = '--'; break;
            case K_PLUS_EQUAL: str = '+='; break;
            case K_MINUS_EQUAL: str = '-='; break;
            case K_MUL_EQUAL: str = '*='; break;
            case K_DIV_EQUAL: str = '/='; break;
            case K_LOGICAL_AND: str = '&&'; break;
            case K_LOGICAL_OR: str = '||'; break;
            case K_EQ: str = '=='; break;
            case K_NEQ: str = '!='; break;
            case K_GT: str = '>'; break;
            case K_GTE: str = '>='; break;
            case K_LT: str = '<'; break;
            case K_LTE: str = '<='; break;
            default: str = '';
          }
        } else if (token >= 200) str = this.table[address].str;
        else str = String.fromCharCode(token);
    }
    return str;
  }
}

function tokenize(program) {
  if (program.indexOf('/*') >= 0 && program.indexOf('*/') >= 0) program = addSpacesToEmptyLines(program);
  const st = new StreamTokenizer(program);
  st.configureForMacros();
  const pgm = new Program();
  let token = 0, tokenString = null, tokenValue = 0, lineNumber = 0;

  function getHexConstant() {
    token = st.nextToken();
    if (st.ttype !== TT_WORD) { st.pushBack(); return 0.0; }
    if (!st.sval.startsWith('x')) { st.pushBack(); return 0.0; }
    const s = st.sval.substring(1);
    // Long.parseLong(s, 16): an empty, non-hex or out-of-range word is a NumberFormatException
    if (!/^[0-9a-fA-F]+$/.test(s) || BigInt('0x' + s) > 0x7fffffffffffffffn) { st.pushBack(); return 0.0; }
    return Number(BigInt('0x' + s));
  }

  /* Tokenizer.tryScientificNotation: a number directly followed by e / E. */
  function tryScientificNotation() {
    const sval = javaDouble(tokenValue);
    try {
      st.nextToken();
      let sval2 = st.sval;
      if (st.ttype === TT_WORD && (sval2.startsWith('e') || sval2.startsWith('E'))) {
        if (sval2.toLowerCase() === 'e') {
          const next = st.nextToken();
          if (next === 45) sval2 += '-';
          else if (next !== 43) throw 0;
          if (st.nextToken() !== TT_NUMBER) throw 0;
          sval2 += javaDouble(st.nval);
        }
        if (sval2.endsWith('.0')) sval2 = sval2.substring(0, sval2.length - 2);
        const v = parseJavaDouble(sval + sval2);
        if (v === null) throw 0;
        tokenValue = v;
        return true;
      }
      st.pushBack();
    } catch (e) { if (e !== 0) throw e; }
    return false;
  }

  function getToken() {
    token = st.nextToken();
    lineNumber = st.lineno;
    let ret = null, nextToken;
    switch (st.ttype) {
      case TT_EOF: ret = 'EOF'; token = EOF; break;
      case TT_WORD: ret = st.sval; token = WORD; break;
      case TT_NUMBER:
        ret = '' + st.nval;
        tokenValue = st.nval;
        if (tokenValue === 0.0) tokenValue = getHexConstant();
        else if (tryScientificNotation()) ret += st.sval;
        token = NUMBER;
        break;
      case 34: case 39: ret = '' + st.sval; token = STRING_CONSTANT; break;
      case 43:
        nextToken = st.nextToken();
        if (nextToken === 43) token = K_PLUS_PLUS;
        else if (nextToken === 61) token = K_PLUS_EQUAL;
        else st.pushBack();
        break;
      case 45:
        nextToken = st.nextToken();
        if (nextToken === 45) token = K_MINUS_MINUS;
        else if (nextToken === 61) token = K_MINUS_EQUAL;
        else st.pushBack();
        break;
      case 42:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_MUL_EQUAL; else st.pushBack();
        break;
      case 47:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_DIV_EQUAL; else st.pushBack();
        break;
      case 61:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_EQ; else st.pushBack();
        break;
      case 33:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_NEQ; else st.pushBack();
        break;
      case 62:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_GTE;
        else if (nextToken === 62) token = K_SHIFT_RIGHT;
        else { st.pushBack(); token = K_GT; }
        break;
      case 60:
        nextToken = st.nextToken();
        if (nextToken === 61) token = K_LTE;
        else if (nextToken === 60) token = K_SHIFT_LEFT;
        else { st.pushBack(); token = K_LT; }
        break;
      case 38:
        nextToken = st.nextToken();
        if (nextToken === 38) token = K_LOGICAL_AND; else st.pushBack();
        break;
      case 124:
        nextToken = st.nextToken();
        if (nextToken === 124) token = K_LOGICAL_OR; else st.pushBack();
        break;
      default:
    }
    tokenString = ret;
  }

  function addToken() {
    let tok = token;
    switch (token) {
      case WORD: {
        const symbol = pgm.lookupWord(tokenString);
        if (symbol !== null) {
          const type = functionTypeOf(symbol);
          if (type === 0) {
            tok = symbol.type;
            switch (tok) {
              case K_FUNCTION: pgm.hasFunctions = true; break;
              case K_VAR: pgm.hasVars = true; break;
              case K_MACRO: pgm.macroCount++; break;
              default:
            }
          } else tok = type;
          tok += pgm.symTabLoc << TOK_SHIFT;
        } else {
          pgm.addSymbol(newWordSymbol(token, tokenString));
          pgm.words.set(tokenString, pgm.stLoc);
          tok += pgm.stLoc << TOK_SHIFT;
        }
        break;
      }
      case STRING_CONSTANT:
        pgm.addSymbol(newWordSymbol(token, tokenString));
        tok += pgm.stLoc << TOK_SHIFT;
        break;
      case NUMBER:
        pgm.addSymbol(newNumberSymbol(tokenValue));
        tok += pgm.stLoc << TOK_SHIFT;
        break;
      default:
    }
    pgm.addToken(tok, lineNumber);
  }

  do {
    getToken();
    addToken();
  } while (token !== EOF);
  if (pgm.hasFunctions) addUserFunctions(pgm);
  return pgm;
}

/* Tokenizer.addUserFunctions: marks every use of a user function name. */
function addUserFunctions(pgm) {
  const code = pgm.code;
  for (let i = 0; i < code.length; i++) {
    let token = code[i] & TOK_MASK;
    if (token === K_FUNCTION) {
      const nextToken = code[i + 1] & TOK_MASK;
      if (nextToken === WORD || (nextToken >= PREDEFINED_FUNCTION && nextToken <= ARRAY_FUNCTION)) {
        const address = code[i + 1] >> TOK_SHIFT;
        let address2 = address;
        if (nextToken !== WORD) {   // override a built-in function
          pgm.addSymbol(newWordSymbol(WORD, pgm.table[address].str));
          address2 = pgm.stLoc;
          code[i + 1] = WORD + (address2 << TOK_SHIFT);
        }
        const sym = pgm.table[address2];
        sym.type = USER_FUNCTION;
        sym.value = i + 1;   // address of the function
        for (let j = 0; j < code.length; j++) {
          token = code[j] & TOK_MASK;
          if ((token === WORD || (token >= PREDEFINED_FUNCTION && token <= ARRAY_FUNCTION)) &&
              (code[j] >> TOK_SHIFT) === address && (j === 0 || (code[j - 1] & 0xfff) !== K_FUNCTION)) {
            code[j] = USER_FUNCTION;
            code[j] += address2 << TOK_SHIFT;
          } else if (token === EOF) break;
        }
      }
    } else if (token === EOF) break;
  }
}

/* Block comments swallow newlines: give every empty line a space so line numbers stay right. */
function addSpacesToEmptyLines(pgm) {
  const len = pgm.length;
  let sb = '';
  for (let jj = 0; jj < len - 1; jj++) {
    const c = pgm.charAt(jj);
    sb += c;
    if (jj < len - 1 && c === '\n' && pgm.charAt(jj + 1) === '\n') sb += ' ';
  }
  sb += pgm.charAt(len - 1);
  return sb;
}

/* ======================================================================================
 * Variable
 * ==================================================================================== */
const V_VALUE = 0, V_ARRAY = 1, V_STRING = 2;

class Variable {
  constructor(symTabIndex = 0, value = 0, str = null, array = null) {
    this.symTabIndex = symTabIndex;
    this.value = value;
    this.str = str;
    this.array = array;
    this.arraySize = 0;
  }
  clone() { const v = new Variable(this.symTabIndex, this.value, this.str, this.array); v.arraySize = this.arraySize; return v; }
  static num(value) { return new Variable(0, value, null, null); }
  static string(str) { return new Variable(0, 0, str, null); }
  getValue() { return this.str !== null ? toolsParseJavaDoubleOrNaN(this.str) : this.value; }
  setValue(value) { this.value = value; this.str = null; this.array = null; }
  getString() { return this.str; }
  setString(str) { this.str = str; this.value = 0.0; this.array = null; }
  getArray() { return this.array; }
  setArray(array) { this.array = array; this.value = 0.0; this.str = null; this.arraySize = 0; }
  setArraySize(size) {
    if (this.array === null) size = 0;
    else if (size > this.array.length) size = this.array.length;
    this.arraySize = size;
  }
  getArraySize() {
    let size = this.array !== null ? this.array.length : 0;
    if (this.arraySize > 0) size = this.arraySize;
    return size;
  }
  /* Variable.toString: what dump() prints for a stack slot. */
  toString() {
    if (this.array !== null) return 'array[' + this.array.length + ']';
    if (this.str !== null) {
      let t = this.str;
      if (t.length > 80) t = t.substring(0, 80) + '...';
      return '"' + t.split('\n').join(' | ') + '"';
    }
    return this.value === toInt(this.value) ? String(toInt(this.value)) : d2s(this.value, 4);
  }
  getType() {
    if (this.array !== null) return V_ARRAY;
    if (this.str !== null) return V_STRING;
    return V_VALUE;
  }
}
function toolsParseJavaDoubleOrNaN(s) { const v = parseJavaDouble(s); return v === null ? NaN : v; }

/* ======================================================================================
 * Interpreter: the recursive descent parser / interpreter (ij.macro.Interpreter).
 * Every method that can evaluate an expression (and so reach a built-in that may suspend) is a
 * generator; the plain ones only walk tokens.
 * ==================================================================================== */
const SLICE = { slice: true };   // yielded every TICK_MASK+1 loop iterations / calls: a point to yield to the event loop
const TICK_MASK = 15;
/* A request to the driver: run `gen` on a fresh native stack and resume the yielder with its result.
 * ImageJ recurses on the JVM stack (about 1000 user-function levels); nested generators would overflow V8's
 * stack at about 550, so every FN_NEST_STEP levels the driver takes over the nesting. */
class Sub { constructor(gen) { this.gen = gen; } }
const FN_NEST_STEP = 32;
/* Synchronous fast path: dispatch class of a statement, and how often a stretch that cannot yield looks at the abort flag. */
const SYNC_TWIN = 1, SYNC_LOOP = 2, SYNC_GEN = 3, SYNC_HDR = 4;
const SYNC_TICK_MASK = 1023;

class Interpreter {
  constructor(ctx) {
    this.ctx = ctx;
    this.pc = -1;
    this.token = 0;
    this.tokenAddress = 0;
    this.tokenValue = 0;
    this.tokenString = null;
    this.looseSyntax = true;
    this.lineNumber = 0;
    this.checkingType = false;
    this.prefixValue = 0;
    this.stack = null;
    this.topOfStack = -1;
    this.topOfGlobals = -1;
    this.startOfLocals = 0;
    this.done = false;
    this.pgm = null;
    this.func = null;
    this.inFunction = false;
    this.argument = null;
    this.returnValue = null;
    this.calledMacro = false;
    this.inPrint = false;
    this.wasError = false;
    this.inLoop = false;
    this.loopDepth = 0;
    this.evaluating = false;
    this.errorCount = 0;
    this.ignoreErrors = false;
    this.errorMessage = null;
    this.errorLine = null;
    this.evalOutput = null;
    this.callStack = null;
    this.callDepth = 0;
    this.returnException = null;
    this.fnNest = 0;
    this.errorSilent = false;
    this.errorStack = [];
    this.ticks = 0;
    this.syncMemo = null;   // per token index: the dispatch class of the statement that starts there (null = fast path off)
    this.syncInfo = null;   // SyncAnalysis of the current program
  }

  /* ---- synchronous fast path (see "Synchronous fast path") ---- */

  syncReset() {
    this.syncInfo = null;
    this.syncMemo = null;
    if (this.ctx.fastPath !== false) {
      this.syncMemo = new Uint8Array(this.pgm.code.length + 2);
      this.syncInfo = new SyncAnalysis(this.pgm, this.ctx);
    }
  }
  /* Dispatch class of the statement starting at token index i: SYNC_TWIN (run it with the plain twin), SYNC_LOOP (cannot
   * suspend but contains a loop: the generator keeps the loop control, its parts run in the twin), SYNC_HDR (it may
   * suspend somewhere, but its header / condition cannot: the generator evaluates that in the twin) or SYNC_GEN. */
  syncState(i) {
    const m = this.syncMemo;
    if (m === null || i < 0 || i >= m.length) return SYNC_GEN;
    const s = m[i];
    return s !== 0 ? s : (m[i] = this.syncInfo.classify(i));
  }
  /* May the header / condition of the control statement at token index i run in the twin? (its parts cannot suspend) */
  syncFast(i) {
    const m = this.syncMemo;
    if (m === null) return false;
    const c = m[i];
    return c === SYNC_LOOP || c === SYNC_HDR;
  }
  /* The cooperative check of a stretch that cannot yield: a shared abort flag (Int32Array on a SharedArrayBuffer,
   * written by the page) or an already-aborted signal. */
  syncCheck() {
    const c = this.ctx;
    if (c.abortFlag !== null && c.abortFlag !== undefined && Atomics.load(c.abortFlag, 0) !== 0) throw new MacroCancel('abort');
    if (c.signal && c.signal.aborted) throw new MacroCancel('abort');
  }

  /* ---- entry points ---- */

  /* Interpreter.run(String): tokenize and interpret. */
  *run(macro) {
    const pgm = tokenize(macro);
    if (pgm.hasVars && pgm.hasFunctions) yield* this.saveGlobals2(pgm);
    yield* this.runProgram(pgm);
  }

  *runProgram(pgm) {
    this.pgm = pgm;
    this.pc = -1;
    this.callDepth = 0;
    this.syncReset();
    this.pushGlobals();
    if (this.func === null) this.func = new Functions(this, pgm); else this.func.pgm = pgm;
    this.done = false;
    this.errorMessage = null;
    yield* this.doStatements();
    this.finishUp();
  }

  /* Runs the var statements ahead of everything else so functions see them. */
  *saveGlobals2(pgm) {
    this.pgm = pgm;
    this.pc = -1;
    this.func = new Functions(this, pgm);
    while (!this.done) {
      this.getToken();
      switch (this.token) {
        case K_VAR: yield* this.doVar(); break;
        case K_MACRO: this.skipMacro(); break;
        case K_FUNCTION: this.skipFunction(); break;
        default:
      }
    }
    if (this.topOfStack !== -1) {
      const n = this.topOfStack + 1;
      pgm.globals = new Array(n);
      for (let i = 0; i < n; i++) pgm.globals[i] = this.stack[i];
    }
    this.pc = -1;
    this.topOfStack = -1;
    this.done = false;
  }

  finishUp() { /* nothing to restore: no images, windows or writers of its own */ }

  /* ---- token access ---- */

  getToken() {
    if (this.done) return;
    let t = this.pgm.code[++this.pc];
    if (t === undefined) t = 0;
    this.token = t;
    if (t <= 127) return;
    this.tokenAddress = t >> TOK_SHIFT;
    this.token = t & TOK_MASK;
    const sym = this.pgm.table[this.tokenAddress];
    this.tokenString = sym.str;
    this.tokenValue = sym.value;
    this.done = this.token === EOF;
  }
  nextToken() { return this.pgm.code[this.pc + 1] & TOK_MASK; }
  nextNextToken() { return this.pgm.code[this.pc + 2] & TOK_MASK; }
  putTokenBack() {
    this.pc--;
    if (this.pc < 0) this.pc = -1;
    if (this.token === EOF) this.done = false;
  }

  *doStatements() {
    while (!this.done) yield* this.doStatement();
  }

  *doStatement() {
    if (this.syncMemo !== null && this.syncState(this.pc + 1) === SYNC_TWIN) { this.doStatement$s(); return; }   /*gen-only*/
    this.getToken();
    switch (this.token) {
      case K_VAR:
        yield* this.doVar();
        break;
      case PREDEFINED_FUNCTION:
        yield* this.func.doFunction(this.pgm.table[this.tokenAddress].type);
        break;
      case USER_FUNCTION:
        yield* this.runUserFunction();
        break;
      case K_RETURN:
        yield* this.doReturn();
        break;
      case K_BREAK:
        if (this.inLoop) throw new MacroException(K_BREAK);
        break;
      case K_CONTINUE:
        if (this.inLoop) throw new MacroException(K_CONTINUE);
        break;
      case WORD:
        if (this.pgm.code[this.pc + 1] === DOT) yield* this.doStringFunction();
        else yield* this.doAssignment();
        break;
      case K_IF:
        yield* this.doIf();
        return;
      case K_ELSE:
        this.error('Else without if');
        return;
      case K_FOR:
        yield* this.doFor();
        return;
      case K_WHILE:
        yield* this.doWhile();
        return;
      case K_DO:
        yield* this.doDo();
        return;
      case K_MACRO:
        yield* this.runFirstMacro();
        return;
      case K_FUNCTION:
        this.skipFunction();
        return;
      case SEMI:
        return;
      case LBRACE:
        this.putTokenBack();
        yield* this.doBlock();
        return;
      case NUMBER: case NUMERIC_FUNCTION: case STRING_FUNCTION: case STRING_CONSTANT:
      case VARIABLE_FUNCTION: case LP: {
        this.putTokenBack();
        this.inPrint = true;
        const s = yield* this.getString();
        this.inPrint = false;
        if (s !== null && s.length > 0 && s !== 'NaN' && s !== '[aborted]') this.log(s);
        return;
      }
      case ARRAY_FUNCTION:
        yield* this.func.getArrayFunction(this.pgm.table[this.tokenAddress].type);
        break;
      case EOF:
        break;
      default:
        if (this.evaluating && this.token === K_PI) {
          this.putTokenBack();
          this.log('' + javaDouble(yield* this.getExpression()));
        } else
          this.error("Statement cannot begin with '" + this.pgm.decodeToken(this.token, this.tokenAddress) + "'");
    }
    if (!this.looseSyntax) {
      this.getToken();
      if (this.token !== SEMI && !this.done) this.error("';' expected");
    }
  }

  /* `s.length;` etc. at the start of a statement. */
  *doStringFunction() {
    const stringFunction = (this.pgm.code[this.pc + 2] & 0xff) === STRING_FUNCTION;
    this.putTokenBack();
    let s = stringFunction ? yield* this.getString() : javaDouble(yield* this.getExpression());
    if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
    this.ctx.log(s);
  }

  log(s) {
    if (this.evaluating) this.evalOutput = s;
    else this.ctx.log(s);
  }

  /* ---- user functions ---- */

  growCallStack(grow) {
    if (this.callStack === null) { this.callStack = new Array(10).fill(0); this.callDepth = 0; }
    if (this.callDepth < 0 || this.callDepth > 8) return;
    if (grow === 1) this.callStack[this.callDepth++] = this.pgm.lineNumbers[this.pc];
    if (grow === -1 && this.callDepth > 0) this.callDepth--;
  }

  *runUserFunction() {
    this.growCallStack(1);
    if ((++this.ticks & TICK_MASK) === 0) yield SLICE;
    const newPC = toInt(this.tokenValue);
    const saveStartOfLocals = this.startOfLocals;
    this.startOfLocals = this.topOfStack + 1;
    const saveTOS = this.topOfStack;
    const nArgs = yield* this.pushArgs();
    const savePC = this.pc;
    let value = null;
    this.pc = newPC;
    this.setupArgs(nArgs);
    const saveInFunction = this.inFunction;
    this.inFunction = true;
    const syncBody = this.syncMemo !== null && this.syncState(this.pc + 1) === SYNC_TWIN;   /*gen-only*/
    try {
      if (syncBody) { ++this.fnNest; this.doBlock$s(); } else   /*gen-only*/
      if ((++this.fnNest % FN_NEST_STEP) === 0) yield new Sub(this.doBlock());
      else yield* this.doBlock();
    } catch (e) {
      if (!(e instanceof ReturnException)) throw e;
      value = new Variable(0, e.value, e.str, e.array);
      if (value.getArray() !== null && e.arraySize !== 0) value.setArraySize(e.arraySize);
    }
    this.fnNest--;
    this.inFunction = saveInFunction;
    this.pc = savePC;
    this.trimStack(saveTOS, saveStartOfLocals);
    this.growCallStack(-1);
    return value;
  }

  /* Push function arguments onto the stack. */
  *pushArgs() {
    this.getLeftParen();
    let count = 0;
    const args = new Array(MAX_ARGS);
    const code = this.pgm.code;
    if (this.nextToken() !== RP) {
      do {
        if (count === MAX_ARGS) this.error('Too many arguments');
        const next = this.nextToken();
        const nextPlus = code[this.pc + 2] & 0xff;
        if (next === STRING_CONSTANT || next === STRING_FUNCTION)
          args[count] = new Variable(0, 0.0, yield* this.getString());
        else if (next === USER_FUNCTION) {
          const savePC = this.pc;
          this.getToken();   // the function
          const simpleFunctionCall = this.isSimpleFunctionCall(false);
          this.pc = savePC;
          if (simpleFunctionCall) {
            this.getToken();   // the function
            const v2 = yield* this.runUserFunction();
            if (v2 === null) this.error('No return value');
            args[count] = v2;
          } else
            args[count] = new Variable(0, yield* this.getExpression(), null);
        } else if (next === WORD && (nextPlus === COMMA || nextPlus === RP)) {
          let value = 0.0, array = null, arraySize = 0, str = null;
          this.getToken();
          const v = this.lookupVariable();
          if (v !== null) {
            const type = v.getType();
            if (type === V_VALUE) value = v.getValue();
            else if (type === V_ARRAY) { array = v.getArray(); arraySize = v.getArraySize(); }
            else str = v.getString();
          }
          args[count] = new Variable(0, value, str, array);
          if (array !== null) args[count].setArraySize(arraySize);
        } else if (next === WORD && nextPlus === LSQ) {
          const savePC = this.pc;
          this.getToken();
          let v = this.lookupVariable();
          v = yield* this.getArrayElement(v);
          if (v.getString() !== null) args[count] = new Variable(0, 0.0, v.getString(), null);
          else {
            this.pc = savePC;
            args[count] = new Variable(0, yield* this.getExpression(), null);
          }
        } else if (next === WORD && nextPlus === DOT) {   // s.length, s.substring(), etc.
          const stringFunction = (code[this.pc + 3] & 0xff) === 136;
          if (stringFunction) args[count] = new Variable(0, 0.0, yield* this.func.getString(), null);
          else args[count] = new Variable(0, yield* this.getExpression(), null);
        } else if (nextPlus === C('+') && next === WORD) {
          const savePC = this.pc;
          this.getToken();
          const v = this.lookupVariable();
          const isString = v !== null && v.getType() === V_STRING;
          this.pc = savePC;
          if (isString) args[count] = new Variable(0, 0.0, yield* this.getString());
          else args[count] = new Variable(0, yield* this.getExpression(), null);
        } else if (next === ARRAY_FUNCTION) {
          this.getToken();
          const array = yield* this.func.getArrayFunction(this.pgm.table[this.tokenAddress].type);
          args[count] = new Variable(0, 0, null, array);
        } else
          args[count] = new Variable(0, yield* this.getExpression(), null);
        count++;
        this.getToken();
      } while (this.token === COMMA);
      this.putTokenBack();
    }
    const nArgs = count;
    while (count > 0) this.push(args[--count], this);
    this.getRightParen();
    return nArgs;
  }

  setupArgs(nArgs) {
    this.getLeftParen();
    let i = this.topOfStack;
    let count = nArgs;
    if (this.nextToken() !== RP) {
      do {
        this.getToken();
        if (i >= 0) this.stack[i].symTabIndex = this.tokenAddress;
        i--;
        count--;
        this.getToken();
      } while (this.token === COMMA);
      this.putTokenBack();
    }
    if (count !== 0) this.error(nArgs + ' argument' + (nArgs === 1 ? '' : 's') + ' expected');
    this.getRightParen();
  }

  *doReturn() {
    let value = 0.0, str = null, array = null, arraySize = 0;
    this.getToken();
    if (this.token === LP) {
      const next = this.pgm.code[this.pc + 1];
      if ((next & TOK_MASK) === STRING_CONSTANT || (next & TOK_MASK) === STRING_FUNCTION || this.isString(this.pc + 1))
        this.error('String enclosed in parens');
    }
    if (this.token !== SEMI) {
      let isString = this.token === STRING_CONSTANT || this.token === STRING_FUNCTION;
      const isArrayFunction = this.token === ARRAY_FUNCTION;
      if (this.token === WORD) {
        const v = this.lookupLocalVariable(this.tokenAddress);
        if (v !== null && this.nextToken() === SEMI) {
          array = v.getArray();
          if (array !== null) arraySize = v.getArraySize();
          isString = v.getString() !== null;
        } else if (v !== null && this.nextToken() === C('+'))
          isString = v.getType() === V_STRING;
      }
      this.putTokenBack();
      if (isString) str = yield* this.getString();
      else if (isArrayFunction) {
        this.getToken();
        array = yield* this.func.getArrayFunction(this.pgm.table[this.tokenAddress].type);
      } else if (array === null) {
        if ((this.pgm.code[this.pc + 2] & 0xff) === LSQ && this.nextToken() === WORD) {
          const savePC = this.pc;
          this.getToken();
          let v = this.lookupVariable();
          v = yield* this.getArrayElement(v);
          this.pc = savePC;
          if (v.getString() !== null) str = yield* this.getString();
          else value = yield* this.getExpression();
        } else
          value = yield* this.getExpression();
      }
    }
    if (this.inFunction) {
      if (this.returnException === null) this.returnException = new ReturnException();
      const r = this.returnException;
      r.value = value; r.str = str; r.array = array; r.arraySize = arraySize;
      throw r;
    } else {
      this.finishUp();
      if (value !== 0.0 || array !== null) this.error('Macros can only return strings');
      this.returnValue = str;
      this.done = true;
    }
  }

  /* ---- loops and blocks ---- */

  *doFor() {
    const fast = this.syncFast(this.pc);   /*gen-only*/
    //@twin const fast = true;
    const saveLooseSyntax = this.looseSyntax;
    this.looseSyntax = false;
    this.loopDepth++;
    this.inLoop = true;
    this.getToken();
    if (this.token !== LP) this.error("'(' expected");
    this.getToken();   // skip 'var'
    if (this.token !== K_VAR) this.putTokenBack();
    do {
      if (this.nextToken() !== SEMI) { if (fast) this.getAssignmentExpression$s(); else yield* this.getAssignmentExpression(); }
      this.getToken();
    } while (this.token === COMMA);
    if (this.token !== SEMI) this.error("';' expected");
    const condPC = this.pc;
    let startPC = 0;
    let cond = 1;
    const code = this.pgm.code;
    for (;;) {
      if (code[this.pc + 1] !== SEMI) cond = fast ? this.getLogicalExpression$s() : yield* this.getLogicalExpression();
      if (startPC === 0) this.checkBoolean(cond);
      this.getToken();
      if (this.token !== SEMI) this.error("';' expected");
      const incPC = this.pc;
      // skip to start of code
      if (startPC !== 0) this.pc = startPC;
      else {
        while (this.token !== RP) {
          this.getToken();
          if (this.token === LBRACE || this.token === SEMI || this.token === LP || this.done) this.error("')' expected");
        }
      }
      startPC = this.pc;
      if (cond === 1) {
        try {
          if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
          yield* this.doStatement();
        } catch (e) {
          if (!(e instanceof MacroException)) throw e;
          if (e.type === K_BREAK) {
            this.pc = startPC;
            this.skipStatement();
            break;
          }
        }
      } else {
        this.skipStatement();
        break;
      }
      if ((++this.ticks & TICK_MASK) === 0) yield SLICE;
      this.pc = incPC;   // do increment
      do {
        if (this.nextToken() !== RP) { if (fast) this.getAssignmentExpression$s(); else yield* this.getAssignmentExpression(); }
        this.getToken();
      } while (this.token === COMMA);
      this.pc = condPC;
    }
    this.looseSyntax = saveLooseSyntax;
    this.loopDepth--;
    if (this.loopDepth === 0) this.inLoop = false;
  }

  *doWhile() {
    const fast = this.syncFast(this.pc);   /*gen-only*/
    //@twin const fast = true;
    this.looseSyntax = false;
    this.loopDepth++;
    this.inLoop = true;
    const savePC = this.pc;
    let isTrue;
    do {
      this.pc = savePC;
      isTrue = fast ? this.getBoolean$s() : yield* this.getBoolean();
      if (isTrue) {
        try {
          if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
          yield* this.doStatement();
        } catch (e) {
          if (!(e instanceof MacroException)) throw e;
          if (e.type === K_BREAK) {
            this.pc = savePC;
            yield* this.getBoolean();
            this.skipStatement();
            break;
          }
        }
      } else
        this.skipStatement();
      if ((++this.ticks & TICK_MASK) === 0) yield SLICE;
    } while (isTrue && !this.done);
    this.loopDepth--;
    if (this.loopDepth === 0) this.inLoop = false;
  }

  *doDo() {
    const fast = this.syncFast(this.pc);   /*gen-only*/
    //@twin const fast = true;
    this.looseSyntax = false;
    const savePC = this.pc;
    let isTrue;
    do {
      if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
      yield* this.doStatement();
      this.getToken();
      if (this.token !== K_WHILE) this.error("'while' expected");
      isTrue = fast ? this.getBoolean$s() : yield* this.getBoolean();
      if (isTrue) this.pc = savePC;
      if ((++this.ticks & TICK_MASK) === 0) yield SLICE;
    } while (isTrue && !this.done);
  }

  *doBlock() {
    this.getToken();
    if (this.token !== LBRACE) this.error("'{' expected");
    while (!this.done) {
      this.getToken();
      if (this.token === RBRACE) break;
      this.putTokenBack();
      if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
      yield* this.doStatement();
    }
    if (this.token !== RBRACE) this.error("'}' expected");
  }

  skipStatement() {
    if (this.done) return;
    this.getToken();
    switch (this.token) {
      case PREDEFINED_FUNCTION: case USER_FUNCTION: case K_VAR:
      case WORD: case LP: case K_PLUS_PLUS: case K_RETURN: case ARRAY_FUNCTION:
      case NUMERIC_FUNCTION: case STRING_FUNCTION: case VARIABLE_FUNCTION:
        this.skipSimpleStatement();
        break;
      case K_IF:
        this.skipParens();
        this.skipStatement();
        this.getToken();
        if (this.token === K_ELSE) this.skipStatement();
        else this.putTokenBack();
        break;
      case K_FOR:
        this.skipParens();
        this.skipStatement();
        break;
      case K_WHILE:
        this.skipParens();
        this.skipStatement();
        break;
      case K_DO:
        this.skipStatement();
        this.getToken();   // skip 'while'
        this.skipParens();
        break;
      case K_BREAK: case K_CONTINUE: case SEMI:
        break;
      case LBRACE:
        this.putTokenBack();
        this.skipBlock();
        break;
      default:
        this.error("Skipped statement cannot begin with '" + this.pgm.decodeToken(this.token, this.tokenAddress) + "'");
    }
  }

  skipBlock() {
    let count = 0;
    do {
      this.getToken();
      if (this.token === LBRACE) count++;
      else if (this.token === RBRACE) count--;
      else if (this.done) { this.error("'}' expected"); return; }
    } while (count > 0);
  }

  skipParens() {
    let count = 0;
    do {
      this.getToken();
      if (this.token === LP) count++;
      else if (this.token === RP) count--;
      else if (this.done) { this.error("')' expected"); return; }
    } while (count > 0);
  }

  skipSimpleStatement() {
    let finished = this.done;
    this.getToken();
    while (!finished && !this.done) {
      if (this.token === SEMI) finished = true;
      else if (this.token === K_ELSE || (this.token === PREDEFINED_FUNCTION && this.pgm.code[this.pc - 1] !== DOT))
        this.error("';' expected");
      else this.getToken();
    }
  }

  skipFunction() {
    this.getToken();   // skip function id
    this.skipParens();
    this.skipBlock();
  }

  *runFirstMacro() {
    this.getToken();   // skip macro label
    yield* this.doBlock();
    this.done = true;
    this.finishUp();
  }

  skipMacro() {
    this.getToken();   // skip macro label
    this.skipBlock();
  }

  /* ---- assignments ---- */

  *doAssignment() {
    const next = this.pgm.code[this.pc + 1] & 0xff;
    if (next === LSQ) { yield* this.doArrayElementAssignment(); return; }
    const type = yield* this.getExpressionType();
    switch (type) {
      case V_STRING: yield* this.doStringAssignment(); break;
      case V_ARRAY: yield* this.doArrayAssignment(); break;
      case USER_FUNCTION: yield* this.doUserFunctionAssignment(); break;
      case STRING_FUNCTION: yield* this.doNumericStringAssignment(); break;
      default: {
        this.putTokenBack();
        const value = yield* this.getAssignmentExpression();
        if (this.evaluating) this.log('' + javaDouble(value));
      }
    }
  }

  *getExpressionType() {
    const code = this.pgm.code;
    const rightSideToken = code[this.pc + 2];
    const tok = rightSideToken & 0xff;
    if (tok === STRING_CONSTANT) return V_STRING;
    if (tok === STRING_FUNCTION) {
      const address = rightSideToken >> TOK_SHIFT;
      const type = this.pgm.table[address].type;
      if (type === K_DIALOG) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'getNumber' || name === 'getCheckbox') return STRING_FUNCTION;
      } else if (type === K_FILE) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'exists' || name === 'isDirectory' || name === 'length' ||
            name === 'getLength' || name === 'rename' || name === 'delete') return STRING_FUNCTION;
      } else if (type === K_LIST) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'getValue') return STRING_FUNCTION;
      } else if (this.numericStringFunction(this.pc + 2))
        return V_VALUE;
      return V_STRING;
    }
    if (tok === ARRAY_FUNCTION) return V_ARRAY;
    if (tok === USER_FUNCTION) return USER_FUNCTION;
    if (tok === VARIABLE_FUNCTION) {
      if (this.isString(this.pc + 2)) return V_STRING;
      const token2 = code[this.pc + 4];
      const name = this.pgm.table[token2 >> TOK_SHIFT].str;
      if (name === 'getColumn' || name === 'toArray') return V_ARRAY;
    }
    if (tok !== WORD) return V_VALUE;
    const v = this.lookupVariableAt(rightSideToken >> TOK_SHIFT);
    if (v === null) return V_VALUE;
    const type = v.getType();
    if (type === V_VALUE) return V_VALUE;
    else if (type === V_STRING) {
      if (this.isString(this.pc + 2)) return V_STRING;
      return V_VALUE;
    }
    if (code[this.pc + 3] === DOT) return V_VALUE;
    if (code[this.pc + 3] !== LSQ) return V_ARRAY;
    const savePC = this.pc;
    this.getToken();   // "="
    this.getToken();   // the variable
    this.checkingType = true;
    const index = yield* this.getIndex();
    this.checkingType = false;
    this.pc = savePC - 1;
    this.getToken();
    const array = v.getArray();
    if (index < 0 || index >= array.length) return V_VALUE;
    return array[index].getType();
  }

  /* Dialog.getNumber() and friends: a string function that returns a number. */
  *doNumericStringAssignment() {
    this.putTokenBack();
    this.getToken();
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) v = this.pushNew(this.tokenAddress, 0.0, null, this);
    this.getToken();
    if (this.token !== EQUALS) this.error("'=' expected");
    v.setValue(yield* this.getExpression());
  }

  *doArrayElementAssignment() {
    const code = this.pgm.code;
    const v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) this.error('Undefined identifier');
    if (code[this.pc + 5] === SEMI && (code[this.pc + 4] === K_PLUS_PLUS || code[this.pc + 4] === K_MINUS_MINUS)) {
      this.putTokenBack();
      yield* this.getFactor();
      return;
    }
    const index = yield* this.getIndex();
    const expressionType = yield* this.getExpressionType();
    if (expressionType === V_ARRAY) this.error('Arrays of arrays not supported');
    this.getToken();
    const op = this.token;
    if (!(op === EQUALS || op === K_PLUS_EQUAL || op === K_MINUS_EQUAL || op === K_MUL_EQUAL || op === K_DIV_EQUAL)) {
      this.error("'=', '+=', '-=', '*=' or '/=' expected");
      return;
    }
    if (op !== EQUALS && (expressionType === V_STRING || expressionType === V_ARRAY)) {
      this.error("'=' expected");
      return;
    }
    let array = v.getArray();
    if (array === null) this.error('Array expected');
    if (index < 0) this.error('Negative index');
    if (index >= array.length) {   // expand array
      if (!this.func.expandableArrays) this.error('Index (' + index + ') out of range');
      const len2 = index + Math.floor(array.length / 2) + 1;
      checkArraySize(this, len2);
      const array2 = new Array(len2);
      const strings = array.length > 0 && array[0].getString() !== null;
      for (let i = 0; i < len2; i++) {
        if (i < array.length) array2[i] = array[i];
        else {
          array2[i] = Variable.num(NaN);
          if (strings) array2[i].setString('undefined');
        }
      }
      v.setArray(array2);
      v.setArraySize(index + 1);
      array = v.getArray();
    }
    const size = v.getArraySize();
    if (index + 1 > size) v.setArraySize(index + 1);
    switch (expressionType) {
      case V_STRING:
        array[index].setString(yield* this.getString());
        break;
      case V_ARRAY:
        this.getToken();
        if (this.token === ARRAY_FUNCTION)
          array[index].setArray(yield* this.func.getArrayFunction(this.pgm.table[this.tokenAddress].type));
        break;
      case USER_FUNCTION: {
        const savePC = this.pc;
        this.getToken();   // the function
        const simpleFunctionCall = this.isSimpleFunctionCall(true);
        this.pc = savePC;
        if (simpleFunctionCall) {
          this.getToken();   // the function
          const v2 = yield* this.runUserFunction();
          if (v2 === null) this.error('No return value');
          if (this.done) return;
          const type = v2.getType();
          if (type === V_VALUE) array[index].setValue(v2.getValue());
          else array[index].setString(v2.getString());
        } else
          array[index].setValue(yield* this.getExpression());
        break;
      }
      default:
        switch (op) {
          case EQUALS: array[index].setValue(yield* this.getExpression()); break;
          case K_PLUS_EQUAL: array[index].setValue(array[index].getValue() + (yield* this.getExpression())); break;
          case K_MINUS_EQUAL: array[index].setValue(array[index].getValue() - (yield* this.getExpression())); break;
          case K_MUL_EQUAL: array[index].setValue(array[index].getValue() * (yield* this.getExpression())); break;
          case K_DIV_EQUAL: array[index].setValue(array[index].getValue() / (yield* this.getExpression())); break;
          default:
        }
    }
  }

  *doUserFunctionAssignment() {
    this.putTokenBack();
    const savePC = this.pc;
    this.getToken();   // the variable
    this.getToken();   // '='
    this.getToken();   // the function
    const simpleAssignment = this.isSimpleFunctionCall(true);
    this.pc = savePC;
    if (!simpleAssignment) yield* this.getAssignmentExpression();
    else {
      this.getToken();
      let v1 = this.lookupLocalVariable(this.tokenAddress);
      if (v1 === null) v1 = this.pushNew(this.tokenAddress, 0.0, null, this);
      this.getToken();
      if (this.token !== EQUALS) this.error("'=' expected");
      this.getToken();   // the function
      const v2 = yield* this.runUserFunction();
      if (v2 === null) this.error('No return value');
      if (this.done) return;
      const type = v2.getType();
      if (type === V_VALUE) v1.setValue(v2.getValue());
      else if (type === V_ARRAY) { v1.setArray(v2.getArray()); v1.setArraySize(v2.getArraySize()); }
      else v1.setString(v2.getString());
    }
  }

  isSimpleFunctionCall(assignment) {
    let count = 0;
    do {
      this.getToken();
      if (this.token === LP) count++;
      else if (this.token === RP) count--;
      else if (this.done) this.error("')' expected");
    } while (count > 0);
    this.getToken();
    if (assignment) return this.token === SEMI;
    return this.token === COMMA || this.token === RP;
  }

  *doStringAssignment() {
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) {
      if (this.nextToken() === EQUALS) v = this.pushNew(this.tokenAddress, 0.0, null, this);
      else this.error('Undefined identifier');
    }
    this.getToken();
    if (this.token === EQUALS) v.setString(yield* this.getString());
    else if (this.token === K_PLUS_EQUAL) v.setString(v.getString() + (yield* this.getString()));
    else this.error("'=' or '+=' expected");
  }

  *doArrayAssignment() {
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) {
      if (this.nextToken() === EQUALS) v = this.pushNew(this.tokenAddress, 0.0, null, this);
      else this.error('Undefined identifier');
    }
    this.getToken();
    if (this.token !== EQUALS) { this.error("'=' expected"); return; }
    this.getToken();
    if (this.token === ARRAY_FUNCTION)
      v.setArray(yield* this.func.getArrayFunction(this.pgm.table[this.tokenAddress].type));
    else if (this.token === WORD) {
      const v2 = this.lookupVariable();
      v.setArray(v2.getArray());
      v.setArraySize(v2.getArraySize());
    } else if (this.token === VARIABLE_FUNCTION) {
      const v2 = yield* this.func.getVariableFunction(this.pgm.table[this.tokenAddress].type);
      const array = v2.getArray();
      if (array === null) this.error('Array expected');
      v.setArray(array);
    } else
      this.error('Array expected');
  }

  *doIf() {
    const fast = this.syncFast(this.pc);   /*gen-only*/
    //@twin const fast = true;
    this.looseSyntax = false;
    const b = fast ? this.getBoolean$s() : yield* this.getBoolean();
    if (b) {
      if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
      yield* this.doStatement();
    } else this.skipStatement();
    let next = this.nextToken();
    if (next === SEMI) {
      this.getToken();
      next = this.nextToken();
    }
    if (next === K_ELSE) {
      this.getToken();
      if (b) this.skipStatement();
      else {
        if (this.syncState(this.pc + 1) === SYNC_TWIN) this.doStatement$s(); else   /*gen-only*/
        yield* this.doStatement();
      }
    }
  }

  *getBoolean() {
    this.getLeftParen();
    const value = yield* this.getLogicalExpression();
    this.checkBoolean(value);
    this.getRightParen();
    return value === 0.0 ? false : true;
  }

  *getLogicalExpression() {
    const v1 = yield* this.getBooleanExpression();
    const next = this.nextToken();
    if (!(next === K_LOGICAL_AND || next === K_LOGICAL_OR)) return v1;
    this.checkBoolean(v1);
    this.getToken();
    const op = this.token;
    const v2 = yield* this.getLogicalExpression();
    this.checkBoolean(v2);
    if (op === K_LOGICAL_AND) return toInt(v1) & toInt(v2);
    else if (op === K_LOGICAL_OR) return toInt(v1) | toInt(v2);
    return v1;
  }

  *getBooleanExpression() {
    let v1 = 0.0, s1 = null;
    let next = this.pgm.code[this.pc + 1];
    const tok = next & TOK_MASK;
    if (tok === STRING_CONSTANT || tok === STRING_FUNCTION || this.isString(this.pc + 1)) {
      if (this.numericStringFunction(this.pc + 1)) v1 = yield* this.getExpression();
      else s1 = yield* this.getString();
    } else
      v1 = yield* this.getExpression();
    next = this.nextToken();
    if (next >= K_EQ && next <= K_LTE) {
      this.getToken();
      const op = this.token;
      if (s1 !== null) return this.compareStrings(s1, yield* this.getString(), op);
      const v2 = yield* this.getExpression();
      switch (op) {
        case K_EQ: v1 = v1 === v2 ? 1.0 : 0.0; break;
        case K_NEQ: v1 = v1 !== v2 ? 1.0 : 0.0; break;
        case K_GT: v1 = v1 > v2 ? 1.0 : 0.0; break;
        case K_GTE: v1 = v1 >= v2 ? 1.0 : 0.0; break;
        case K_LT: v1 = v1 < v2 ? 1.0 : 0.0; break;
        case K_LTE: v1 = v1 <= v2 ? 1.0 : 0.0; break;
        default:
      }
    } else if (s1 !== null) {
      if (s1 === 'true') v1 = 1.0;
      else if (s1 === 'false') v1 = 0.0;
      else v1 = toolsParseDouble(s1, NaN);
    }
    return v1;
  }

  numericStringFunction(loc) {
    const code = this.pgm.code;
    if ((code[loc] & TOK_MASK) !== STRING_FUNCTION) return false;
    const address = code[loc] >> TOK_SHIFT;
    const type = this.pgm.table[address].type;
    if (type === VARIABLE_FUNCTION || type === K_DIALOG || type === K_FILE || type === K_STRING ||
        type === K_EXT || type === K_LIST || type === K_IJ_CALL) return false;
    if (code[loc + 1] === DOT && (code[loc + 2] & 0xff) !== STRING_FUNCTION) return true;
    if (code[loc + 1] === LP && code[loc + 2] === RP && code[loc + 3] === DOT && (code[loc + 4] & 0xff) !== STRING_FUNCTION) return true;
    return false;
  }

  /* True if the token at the specified location is a string. */
  isString(pcLoc) {
    const code = this.pgm.code;
    const tok = code[pcLoc];
    if ((tok & 0xff) === VARIABLE_FUNCTION) {
      const address = tok >> TOK_SHIFT;
      const type = this.pgm.table[address].type;
      const token2 = code[pcLoc + 2];
      const name = this.pgm.table[token2 >> TOK_SHIFT].str;
      if (isStringFunctionName(name, type)) return true;
    }
    if ((tok & TOK_MASK) !== WORD) return false;
    const v = this.lookupVariableAt(tok >> TOK_SHIFT);
    if (v === null) return false;
    if (code[pcLoc + 1] === LSQ) {
      const array = v.getArray();
      if (array !== null && array.length > 0) return array[0].getType() === V_STRING;
    }
    const type = v.getType();
    if (type === V_STRING && (code[pcLoc + 1] & 0xff) === DOT && (code[pcLoc + 2] & 0xff) !== STRING_FUNCTION) return false;
    return type === V_STRING;
  }

  compareStrings(s1, s2, op) {
    const result = compareToIgnoreCase(s1, s2);
    switch (op) {
      case K_EQ: return result === 0 ? 1.0 : 0.0;
      case K_NEQ: return result !== 0 ? 1.0 : 0.0;
      case K_GT: return result > 0 ? 1.0 : 0.0;
      case K_GTE: return result >= 0 ? 1.0 : 0.0;
      case K_LT: return result < 0 ? 1.0 : 0.0;
      case K_LTE: return result <= 0 ? 1.0 : 0.0;
      default: return 0.0;
    }
  }

  *getAssignmentExpression() {
    const code = this.pgm.code;
    const tokPlus2 = code[this.pc + 2];
    if ((code[this.pc + 1] & 0xff) === WORD && (tokPlus2 === EQUALS || tokPlus2 === K_PLUS_EQUAL ||
        tokPlus2 === K_MINUS_EQUAL || tokPlus2 === K_MUL_EQUAL || tokPlus2 === K_DIV_EQUAL)) {
      this.getToken();
      let v = this.lookupLocalVariable(this.tokenAddress);
      const saveAddress = this.tokenAddress;
      this.getToken();
      let value = 0.0;
      if (this.token === EQUALS) value = yield* this.getAssignmentExpression();
      else {
        value = v !== null ? v.getValue() : 0.0;
        switch (this.token) {
          case K_PLUS_EQUAL: value += yield* this.getAssignmentExpression(); break;
          case K_MINUS_EQUAL: value -= yield* this.getAssignmentExpression(); break;
          case K_MUL_EQUAL: value *= yield* this.getAssignmentExpression(); break;
          case K_DIV_EQUAL: value /= yield* this.getAssignmentExpression(); break;
          default:
        }
      }
      if (v === null) v = this.pushNew(saveAddress, 0.0, null, this);
      v.setValue(value);
      return value;
    }
    return yield* this.getLogicalExpression();
  }

  checkBoolean(value) {
    if (!(value === 0.0 || value === 1.0)) this.error('Boolean expression expected: ' + javaDouble(value));
  }

  *doVar() {
    this.getToken();
    while (this.token === WORD) {
      if (this.nextToken() === EQUALS) yield* this.doAssignment();
      else {
        const v = this.lookupVariableAt(this.tokenAddress);
        if (v === null) this.pushNew(this.tokenAddress, 0.0, null, this);
      }
      this.getToken();
      if (this.token === COMMA) this.getToken();
      else { this.putTokenBack(); break; }
    }
  }

  getLeftParen() { this.getToken(); if (this.token !== LP) this.error("'(' expected"); }
  getRightParen() { this.getToken(); if (this.token !== RP) this.error("')' expected"); }
  getParens() {
    if (this.nextToken() === LP) { this.getLeftParen(); this.getRightParen(); }
  }
  getComma() {
    this.getToken();
    if (this.token !== COMMA) {
      if (this.looseSyntax) this.putTokenBack();
      else this.error("',' expected");
    }
  }

  /* ---- errors ---- */

  error(message) {
    this.errorMessage = message;
    if (this.ignoreErrors) return;
    this.errorCount++;
    const showMessage = !this.done;
    this.token = EOF;
    this.tokenString = '';
    this.wasError = true;
    this.errorSilent = !(showMessage && message !== null);
    if (showMessage && message !== null) {
      let line = this.getErrorLine();
      this.done = true;
      if (line.length > 120) line = line.substring(0, 119) + '...';
      let calledFrom = '';
      const stack = [];
      if (this.callDepth > 0 && this.callStack !== null)
        for (let jj = this.callDepth - 1; jj >= 0; jj--) { calledFrom += '\t\t(called from line ' + this.callStack[jj] + ')\n'; stack.push(this.callStack[jj]); }
      this.errorLine = line;
      this.errorCalledFrom = calledFrom;
      this.errorStack = stack;
      throw new MacroCancel('error');
    }
    this.done = true;
    if (this.errorCount > 10) throw new MacroCancel('error');
  }

  /* The text of the window Interpreter.showError builds. */
  errorDialogText() {
    return this.errorMessage + ' in line ' + this.lineNumber + '\n' + this.errorCalledFrom + ' \n' + this.errorLine;
  }

  /* The source line of the error with the offending token in <>. */
  getErrorLine() {
    const savePC = this.pc;
    if (this.pc < 0) throw new JavaException('java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds');
    const lines = this.pgm.lineNumbers;
    this.lineNumber = lines[this.pc] ?? 0;
    while (this.pc >= 0 && this.lineNumber === (lines[this.pc] ?? 0)) this.pc--;
    if (this.lineNumber <= 1) this.pc = -1;
    let line = '';
    this.getToken();
    while (!this.done && this.lineNumber === (lines[this.pc] ?? 0)) {
      let str = this.pgm.decodeToken(this.token, this.tokenAddress);
      if (this.pc === savePC) str = '<' + str + '>';
      line += str + ' ';
      this.getToken();
    }
    return line;
  }

  /* ---- strings ---- */

  *getString() {
    let str = yield* this.getStringTerm();
    for (;;) {
      this.getToken();
      if (this.token === C('+')) str += yield* this.getStringTerm();
      else { this.putTokenBack(); break; }
    }
    return str;
  }

  *getStringTerm() {
    let str, v;
    this.getToken();
    switch (this.token) {
      case STRING_CONSTANT:
        str = this.tokenString;
        break;
      case STRING_FUNCTION:
        str = yield* this.func.getStringFunction(this.pgm.table[this.tokenAddress].type);
        break;
      case VARIABLE_FUNCTION:
        if (!this.isString(this.pc)) {
          this.putTokenBack();
          str = this.numToString(yield* this.getStringExpression());
          break;
        }
        v = yield* this.func.getVariableFunction(this.pgm.table[this.tokenAddress].type);
        str = v.getString();
        if (str === null) {
          const value = v.getValue();
          str = toInt(value) === value ? d2s(value, 0) : javaDouble(value);
        }
        break;
      case USER_FUNCTION:
        v = yield* this.runUserFunction();
        if (v === null) this.error('No return value');
        str = v.getString();
        if (str === null) {
          const value = v.getValue();
          str = toInt(value) === value ? d2s(value, 0) : javaDouble(value);
        }
        break;
      case WORD:
        str = yield* this.lookupStringVariable();
        if (str !== null) break;
        // falls through
      default:
        this.putTokenBack();
        str = this.numToString(yield* this.getStringExpression());
    }
    return str;
  }

  numToString(x) { return numToString(x, this.evaluating); }

  /* ---- expressions ---- */

  *getExpression() {
    let value = yield* this.getTerm();
    for (;;) {
      const next = this.nextToken();
      if (next === 43) { this.getToken(); value += yield* this.getTerm(); }
      else if (next === 45) { this.getToken(); value -= yield* this.getTerm(); }
      else break;
    }
    return value;
  }

  *getTerm() {
    let value = yield* this.getFactor();
    for (;;) {
      const next = this.nextToken();
      switch (next) {
        case 42: this.getToken(); value *= yield* this.getFactor(); break;
        case 47: this.getToken(); value /= yield* this.getFactor(); break;
        case 37: this.getToken(); value %= yield* this.getFactor(); break;
        case 38: this.getToken(); value = toInt(value) & toInt(yield* this.getFactor()); break;
        case 124: this.getToken(); value = toInt(value) | toInt(yield* this.getFactor()); break;
        case 94: this.getToken(); value = toInt(value) ^ toInt(yield* this.getFactor()); break;
        case K_SHIFT_RIGHT: this.getToken(); value = toInt(value) >> toInt(yield* this.getFactor()); break;
        case K_SHIFT_LEFT: this.getToken(); value = toInt(value) << toInt(yield* this.getFactor()); break;
        default: return value;
      }
    }
  }

  *getFactor() {
    let value = 0.0, v = null;
    this.getToken();
    switch (this.token) {
      case NUMBER:
        value = this.tokenValue;
        break;
      case STRING_CONSTANT:
        value = toolsParseDouble(this.tokenString, NaN);
        break;
      case NUMERIC_FUNCTION:
        value = yield* this.func.getFunctionValue(this.pgm.table[this.tokenAddress].type);
        break;
      case STRING_FUNCTION: {
        const str = yield* this.func.getStringFunction(this.pgm.table[this.tokenAddress].type);
        if (this.nextToken() === DOT) {
          this.getToken();   // '.'
          this.getToken();   // numericFunction
          value = yield* this.getNumericStringFunction(str);
        } else
          value = toolsParseDouble(str, NaN);
        if ('NaN' === str) value = NaN;
        else if (value !== value) this.error('Numeric value expected');
        break;
      }
      case VARIABLE_FUNCTION:
        v = yield* this.func.getVariableFunction(this.pgm.table[this.tokenAddress].type);
        if (v === null) this.error('No return value');
        if (v.getString() !== null) this.error('Numeric return value expected');
        else value = v.getValue();
        break;
      case USER_FUNCTION:
        v = yield* this.runUserFunction();
        if (v === null) this.error('No return value');
        if (this.done) value = 0;
        else {
          if (v.getString() !== null) this.error('Numeric return value expected');
          else value = v.getValue();
        }
        break;
      case K_TRUE: value = 1.0; break;
      case K_FALSE: value = 0.0; break;
      case K_PI: value = Math.PI; break;
      case K_NaN: value = NaN; break;
      case WORD: {
        v = this.lookupVariable();
        if (v === null) return 0.0;
        let next = this.nextToken();
        if (next === LSQ) {
          v = yield* this.getArrayElement(v);
          value = v.getValue();
          next = this.nextToken();
          if (next === DOT) {
            value = yield* this.runNumericFunction(v);
            next = this.nextToken();
          }
        } else if (next === DOT) {
          value = yield* this.runNumericFunction(v);
          next = this.nextToken();
        } else {
          if (v.getArray() !== null) {
            this.getToken();
            this.error("'[' or '.' expected");
          }
          if (this.prefixValue !== 0 && !this.checkingType) {
            v.setValue(v.getValue() + this.prefixValue);
            this.prefixValue = 0;
          }
          value = v.getValue();
        }
        if (!(next === K_PLUS_PLUS || next === K_MINUS_MINUS)) break;
        this.getToken();
        if (this.token === K_PLUS_PLUS) v.setValue(v.getValue() + (this.checkingType ? 0 : 1));
        else v.setValue(v.getValue() - (this.checkingType ? 0 : 1));
        break;
      }
      case LP:
        value = yield* this.getLogicalExpression();
        this.getRightParen();
        break;
      case K_PLUS_PLUS:
        this.prefixValue = 1;
        value = yield* this.getFactor();
        break;
      case K_MINUS_MINUS:
        this.prefixValue = -1;
        value = yield* this.getFactor();
        break;
      case 33:
        value = yield* this.getFactor();
        if (value === 0.0 || value === 1.0) value = value === 0.0 ? 1.0 : 0.0;
        else this.error('Boolean expected');
        break;
      case 45:
        value = -(yield* this.getFactor());
        break;
      case 126:
        value = ~toInt(yield* this.getFactor());
        break;
      default:
        this.error('Number or numeric function expected');
    }
    return value;
  }

  *getNumericStringFunction(str) {
    let value = NaN;
    if (this.token === WORD) {
      if (this.tokenString === 'length') { this.getParens(); value = str.length; }
      else if (this.tokenString === 'contains') value = str.indexOf(yield* this.func.getStringArg()) >= 0 ? 1 : 0;
      else if (this.tokenString === 'charAt') {
        const i = toInt(yield* this.func.getArg());
        if (i < 0 || i >= str.length) throw new JavaException('java.lang.StringIndexOutOfBoundsException: index ' + i + ', length ' + str.length);
        value = str.charCodeAt(i);
      }
    } else if (this.token === NUMERIC_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_INDEX_OF: value = yield* this.func.indexOf(str); break;
        case K_LAST_INDEX_OF: value = str.lastIndexOf(yield* this.func.getStringArg()); break;
        case K_STARTS_WITH: value = str.startsWith(yield* this.func.getStringArg()) ? 1 : 0; break;
        case K_ENDS_WITH: value = str.endsWith(yield* this.func.getStringArg()) ? 1 : 0; break;
        case K_MATCHES: value = yield* this.func.matches(str); break;
        default:
      }
    } else
      this.error('Numeric function expected');
    return value;
  }

  *getArrayElement(v) {
    const index = yield* this.getIndex();
    const array = v.getArray();
    if (array === null) this.error('Array expected');
    if (index < 0 || index >= array.length) {
      if (array.length === 0) this.error('Empty array');
      else this.error('Index (' + index + ') out of 0-' + (array.length - 1) + ' range');
    }
    return array[index];
  }

  *runNumericFunction(v) {
    this.getToken();   // '.'
    this.getToken();
    if (this.token === WORD && v.getArray() !== null && this.tokenString === 'length') return v.getArraySize();
    const str = v.getString();
    if (str === null) this.error('Array or string expected');
    return yield* this.getNumericStringFunction(str);
  }

  *getStringExpression() {
    let value = yield* this.getTerm();
    for (;;) {
      this.getToken();
      if (this.token === 43) {
        this.getToken();
        if (this.token === STRING_CONSTANT || this.token === STRING_FUNCTION) {
          this.putTokenBack();
          this.putTokenBack();
          break;
        }
        if (this.token === WORD) {
          const v = this.lookupVariableAt(this.tokenAddress);
          if (v !== null && v.getString() !== null) {
            this.putTokenBack();
            this.putTokenBack();
            break;
          }
        }
        this.putTokenBack();
        value += yield* this.getTerm();
      } else if (this.token === 45)
        value -= yield* this.getTerm();
      else {
        this.putTokenBack();
        break;
      }
    }
    return value;
  }

  /* ---- variables and the stack ---- */

  /* Searches the local and global sections of the stack. */
  lookupLocalVariable(symTabAddress) {
    const stack = this.stack;
    for (let i = this.topOfStack; i >= this.startOfLocals; i--)
      if (stack[i].symTabIndex === symTabAddress) return stack[i];
    for (let i = this.topOfGlobals; i >= 0; i--)
      if (stack[i].symTabIndex === symTabAddress) return stack[i];
    return null;
  }

  /* Searches the entire stack for the variable at the address (null if absent). */
  lookupVariableAt(symTabAddress) {
    const stack = this.stack;
    for (let i = this.topOfStack; i >= 0; i--)
      if (stack[i].symTabIndex === symTabAddress) return stack[i];
    return null;
  }

  push(variable, interp) {
    if (this.stack === null) this.stack = new Array(STACK_SIZE).fill(null);
    if (this.topOfStack >= STACK_SIZE - 2) interp.error('Stack overflow');
    else this.topOfStack++;
    this.stack[this.topOfStack] = variable;
    return variable;
  }

  pushNew(symTabLoc, value, str, interp) {
    return this.push(new Variable(symTabLoc, value, str), interp);
  }

  pushGlobals() {
    if (this.pgm.globals === null) return;
    if (this.stack === null) this.stack = new Array(STACK_SIZE).fill(null);
    for (let i = 0; i < this.pgm.globals.length; i++) {
      this.topOfStack++;
      this.stack[this.topOfStack] = this.pgm.globals[i];
    }
    this.topOfGlobals = this.topOfStack;
  }

  trimStack(previousTOS, previousStartOfLocals) {
    for (let i = previousTOS + 1; i <= this.topOfStack; i++) this.stack[i] = null;
    this.topOfStack = previousTOS;
    this.startOfLocals = previousStartOfLocals;
  }

  /* Searches the entire stack for the variable of the current token; aborts when absent. */
  lookupVariable() {
    let v = null;
    if (this.stack === null) { this.undefined_(); return v; }
    let found = false;
    for (let i = this.topOfStack; i >= 0; i--) {
      v = this.stack[i];
      if (v.symTabIndex === this.tokenAddress) { found = true; break; }
    }
    if (!found) this.undefined_();
    return v;
  }

  *lookupStringVariable() {
    if (this.stack === null) { this.undefined_(); return ''; }
    let found = false, str = null;
    for (let i = this.topOfStack; i >= 0; i--) {
      if (this.stack[i].symTabIndex === this.tokenAddress) {
        const v = this.stack[i];
        found = true;
        const next = this.nextToken();
        if (next === LSQ) {
          const savePC = this.pc;
          const index = yield* this.getIndex();
          const array = v.getArray();
          if (array === null) this.error('Array expected');
          if (index < 0 || index >= array.length) this.error('Index (' + index + ') out of 0-' + (array.length - 1) + ' range');
          str = array[index].getString();
          const next2 = this.nextToken();
          if (str !== null) {
            if (next2 === DOT) str = yield* this.runStringFunction(str);
          } else {
            if (next2 === RP || next2 === SEMI) str = this.numToString(array[index].getValue());
            else {
              this.pc = savePC - 1;
              this.getToken();
            }
          }
        } else if (next === DOT) {
          if (v.getString() !== null) str = yield* this.runStringFunction(v.getString());
        } else {
          if (v.getArray() !== null) { this.getToken(); this.error("'[' or '.' expected"); }
          str = v.getString();
        }
        break;
      }
    }
    if (!found) this.undefined_();
    return str;
  }

  /* `s.length()`, `s.indexOf(...)`, `s.substring(...)` ... on a string variable. */
  *runStringFunction(str) {
    this.getToken();   // '.'
    this.getToken();
    if (this.token === WORD) {
      if (this.tokenString === 'length') { this.getParens(); str = '' + str.length; }
      else if (this.tokenString === 'contains') str = '' + (str.indexOf(yield* this.func.getStringArg()) >= 0);
      else if (this.tokenString === 'replaceAll') str = yield* this.func.replace(str);
      else str = null;
    } else if (this.token === NUMERIC_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_INDEX_OF: str = '' + (yield* this.func.indexOf(str)); break;
        case K_LAST_INDEX_OF: str = '' + str.lastIndexOf(yield* this.func.getStringArg()); break;
        case K_STARTS_WITH: str = '' + str.startsWith(yield* this.func.getStringArg()); break;
        case K_ENDS_WITH: str = '' + str.endsWith(yield* this.func.getStringArg()); break;
        case K_MATCHES: str = javaDouble(yield* this.func.matches(str)); break;
        default: str = null;
      }
    } else if (this.token === STRING_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_SUBSTRING: str = yield* this.func.substring(str); break;
        case K_TO_LOWER_CASE: this.getParens(); str = str.toLowerCase(); break;
        case K_TO_UPPER_CASE: this.getParens(); str = str.toUpperCase(); break;
        case K_REPLACE: str = yield* this.func.replace(str); break;
        case K_TRIM: this.getParens(); str = javaTrim(str); break;
        case K_CHARAT: {
          const index = toInt(yield* this.func.getArg());
          this.func.checkIndex(index, 0, str.length - 1);
          str = str.charAt(index);
          break;
        }
        default: str = null;
      }
    } else
      str = null;
    if (str === null) this.error('String function expected');
    return str;
  }

  *getIndex() {
    this.getToken();
    if (this.token !== LSQ) this.error("'['expected");
    const index = toInt(yield* this.getExpression());
    this.getToken();
    if (this.token !== RSQ) this.error("']' expected");
    return index;
  }

  undefined_() {
    if (this.nextToken() === LP) this.error('Undefined identifier');
    else this.error('Undefined variable');
  }

  /* Interpreter.dump: symbol table, tokenized program and stack through the Log. */
  dump() {
    this.getParens();
    if (this.done) return;
    const pgm = this.pgm, log = (s) => this.log(s);
    log('');
    log('Symbol Table');
    for (let i = 0; i < pgm.table.length; i++) {
      const sym = pgm.table[i];
      if (sym === null || sym === undefined) break;
      log(i + ' ' + sym.type + ' ' + javaDouble(sym.value) + ' ' + sym.str);
    }
    log('');
    log('Tokenized Program');
    for (let i = 0; i <= pgm.pc; i++)
      log(i + '\t ' + pgm.lineNumbers[i] + '   ' + (pgm.code[i] & TOK_MASK) + '   ' + pgm.decodeToken(pgm.code[i]));
    log('');
    log('Stack');
    if (this.stack !== null) {
      for (let i = this.topOfStack; i >= 0; i--) {
        const v = this.stack[i];
        const sym = v !== null && v !== undefined ? pgm.table[v.symTabIndex] : null;
        log(i + ' ' + (sym ? sym.str : 'null') + ' ' + (v ? v.toString() : 'null'));
      }
    }
  }
}

/* Functions.isStringFunction(name, type): Table.getString(), Roi.getName() ... return strings. */
function isStringFunctionName(name, type) {
  switch (type) {
    case K_TABLE:
      return name === 'getString' || name === 'title' || name === 'headings' || name === 'allHeadings';
    case K_ROI:
      return name === 'getStrokeColor' || name === 'getDefaultColor' || name === 'getFillColor' || name === 'getName' ||
        name === 'getProperty' || name === 'getProperties' || name === 'getGroupNames' || name === 'getType';
    case K_PROPERTY:
      return name === 'getProperty' || name === 'getProperties' || name === 'get' || name === 'getInfo' ||
        name === 'getList' || name === 'getSliceLabel' || name === 'getDicomTag';
    case K_ROI_MANAGER2:
      return name === 'getName';
    case K_IMAGE:
      return name === 'title' || name === 'name';
    case K_COLOR:
      return name === 'foreground' || name === 'background' || name === 'toString' || name === 'wavelengthToColor';
    default:
      return false;
  }
}

/* ======================================================================================
 * Built-in dispatch.
 *
 * ImageJ's built-ins parse their own arguments from the token stream (Functions.getArg(),
 * getFirstString() ...), so a built-in is a function of the Functions object `f`:
 *     (f) => result            (plain, for the ones that never wait)
 *     function* (f) { ... yield* f.getArg() ...; yield promise; return result; }
 * and the table is keyed by the MacroConstants id, one table per kind of call site:
 *     do        statement functions (print, exit, selectWindow ...): result ignored
 *     num       numeric functions -> number
 *     str       string functions -> string (null = no value, as ImageJ)
 *     arr       array functions -> Variable[] (use f.newVariableArray)
 *     variable  functions returning a Variable (Table, Roi, Property, Image, Color)
 * An id without an entry stops the macro with "Function not available in the browser: <name>".
 * Later stages call IJMacro.define(kind, id | name, fn); a built-in that needs the page reaches it
 * through `yield* f.hostCall(name, args)` (host.call, awaited when it returns a Promise).
 * ==================================================================================== */
const BUILTINS = { do: new Map(), num: new Map(), str: new Map(), arr: new Map(), variable: new Map() };
const ID_OF_NAME = {};
for (const tbl of [SYS_FUNCTIONS, SYS_NUMERICFUNCTIONS, SYS_STRINGFUNCTIONS, SYS_ARRAYFUNCTIONS, SYS_VARIABLEFUNCTIONS])
  for (const [n, id] of tbl) ID_OF_NAME[n] = id;

/* Suspension registry of the synchronous fast path (see "Synchronous fast path" below): BUILTIN_INFO[kind] maps an id to
 * { suspends }, the twin tables BUILTINS_S[kind] map an id to a plain function. The built-ins of this file register while
 * `coreDefining` holds (default: never suspends); a later IJMacro.define() without an option defaults to 'host'. */
const BUILTIN_INFO = { do: new Map(), num: new Map(), str: new Map(), arr: new Map(), variable: new Map() };
let coreDefining = true;

function define(kind, id, fn, opts) {
  const table = BUILTINS[kind];
  if (!table) throw new Error('IJMacro.define: unknown kind ' + kind);
  if (typeof id === 'string') {
    if (!(id in ID_OF_NAME)) throw new Error('IJMacro.define: unknown function ' + id);
    id = ID_OF_NAME[id];
  }
  table.set(id, fn);
  const hasSync = !!opts && typeof opts.sync === 'function';
  const suspends = opts && opts.suspends !== undefined ? opts.suspends : (coreDefining ? false : hasSync ? false : 'host');
  BUILTIN_INFO[kind].set(id, { suspends });
  if (!coreDefining) {
    BUILTINS_S[kind].delete(id);   // a replaced built-in loses its generated twin
    if (hasSync) BUILTINS_S[kind].set(id, opts.sync);   // a plain-function body for the fast path (may use f.getArg$s() ...)
  }
}

function isThenable(x) {
  return x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function';
}
function isIterator(r) { return r !== null && typeof r === 'object' && typeof r.next === 'function' && typeof r[Symbol.iterator] === 'function'; }

/* ======================================================================================
 * Functions (ij.macro.Functions): the argument helpers and the dispatch
 * ==================================================================================== */
class Functions {
  constructor(interp, pgm) {
    this.interp = interp;
    this.pgm = pgm;
    this.expandableArrays = true;
    this.writer = null;
    this.props = null;    // List.* (java.util.Properties)
    this.buffer = null;   // String.append / buffer
    this.ran = null;      // random()
  }

  notAvailable(type, kind) {
    this.interp.error('Function not available in the browser: ' + (NAME_OF[type] || type));
    return kind === 'num' ? 0.0 : kind === 'str' ? '' : kind === 'arr' ? [] : null;
  }

  *doFunction(type) {
    const fn = BUILTINS.do.get(type);
    if (fn === undefined) { this.notAvailable(type, 'do'); return; }
    const r = fn(this);
    if (isIterator(r)) yield* r;
  }
  *getFunctionValue(type) {
    const fn = BUILTINS.num.get(type);
    if (fn === undefined) return this.notAvailable(type, 'num');
    const r = fn(this);
    return isIterator(r) ? yield* r : r;
  }
  *getStringFunction(type) {
    const fn = BUILTINS.str.get(type);
    if (fn === undefined) return this.notAvailable(type, 'str');
    const r = fn(this);
    return isIterator(r) ? yield* r : r;
  }
  *getArrayFunction(type) {
    const fn = BUILTINS.arr.get(type);
    if (fn === undefined) return this.notAvailable(type, 'arr');
    const r = fn(this);
    return isIterator(r) ? yield* r : r;
  }
  /* Functions.getVariableFunction: a missing result is NaN. */
  *getVariableFunction(type) {
    const fn = BUILTINS.variable.get(type);
    if (fn === undefined) { this.notAvailable(type, 'variable'); return Variable.num(NaN); }
    const r = fn(this);
    let v = isIterator(r) ? yield* r : r;
    if (v === null || v === undefined) v = Variable.num(NaN);
    return v;
  }

  /* A call to the host page; the result of a Promise is awaited by the driver. */
  *hostCall(name, args) {
    const host = this.interp.ctx.host;
    if (!host || typeof host.call !== 'function') {
      this.interp.error('Function not available in the browser: ' + name);
      return null;
    }
    const v = yield* this.hostHook(() => host.call(name, args || [], this.interp.ctx));
    return v === undefined ? null : v;
  }

  /* Every host hook goes through here: a Promise is awaited by the driver, and a throw or rejection becomes
   * a macro error with its line (what ImageJ shows for an exception inside a built-in). */
  *hostHook(fn) {
    try {
      let v = fn();
      if (isThenable(v)) v = (yield v);
      return v;
    } catch (e) {
      if (e instanceof MacroCancel || e instanceof SyncViolation) throw e;
      this.interp.error(String(e && e.message !== undefined ? e.message : e));
      return undefined;
    }
  }

  /* IJ.showMessage / IJ.error: modal, the macro waits for the host's answer. */
  *showMessage(title, text) { yield* this.hostHook(() => this.interp.ctx.showMessage(title, text)); }

  /* ---- argument helpers (Functions.getArg ... getLastString) ---- */
  *getArg() {
    const it = this.interp;
    it.getLeftParen();
    const arg = yield* it.getExpression();
    it.getRightParen();
    return arg;
  }
  *getFirstArg() { this.interp.getLeftParen(); return yield* this.interp.getExpression(); }
  *getNextArg() { this.interp.getComma(); return yield* this.interp.getExpression(); }
  *getLastArg() {
    this.interp.getComma();
    const arg = yield* this.interp.getExpression();
    this.interp.getRightParen();
    return arg;
  }
  *getString() {
    let str = yield* this.interp.getStringTerm();
    for (;;) {
      this.interp.getToken();
      if (this.interp.token === 43) str += yield* this.interp.getStringTerm();
      else { this.interp.putTokenBack(); break; }
    }
    return str;
  }
  *getStringArg() {
    this.interp.getLeftParen();
    const arg = yield* this.getString();
    this.interp.getRightParen();
    return arg;
  }
  *getFirstString() { this.interp.getLeftParen(); return yield* this.getString(); }
  *getNextString() { this.interp.getComma(); return yield* this.getString(); }
  *getLastString() {
    this.interp.getComma();
    const arg = yield* this.getString();
    this.interp.getRightParen();
    return arg;
  }
  *getBooleanArg() {
    const it = this.interp;
    it.getLeftParen();
    const arg = yield* it.getBooleanExpression();
    it.checkBoolean(arg);
    it.getRightParen();
    return arg === 0 ? false : true;
  }

  /* Functions.getVariable(): the variable (or array element) named by the next token. */
  *getVariable() {
    const it = this.interp;
    it.getToken();
    if (it.token !== WORD) it.error('Variable expected');
    let v = it.lookupLocalVariable(it.tokenAddress);
    if (v === null) v = it.pushNew(it.tokenAddress, 0.0, null, it);
    const array = v.getArray();
    if (array !== null) {
      const index = yield* it.getIndex();
      this.checkIndex(index, 0, v.getArraySize() - 1);
      v = array[index];
    }
    return v;
  }
  *getFirstVariable() { this.interp.getLeftParen(); return yield* this.getVariable(); }
  *getNextVariable() { this.interp.getComma(); return yield* this.getVariable(); }
  *getLastVariable() {
    this.interp.getComma();
    const v = yield* this.getVariable();
    this.interp.getRightParen();
    return v;
  }

  /* Functions.getArray(): the Variable[] named by the next token (a variable, newArray(), ...). */
  *getArray() {
    const it = this.interp;
    it.getToken();
    const newArray = it.token === ARRAY_FUNCTION && this.pgm.table[it.tokenAddress].type === K_NEW_ARRAY;
    const arrayFunction = it.token === ARRAY_FUNCTION;
    if (!(it.token === WORD || newArray || arrayFunction)) it.error('Array expected');
    let a = null;
    if (newArray) a = yield* this.getArrayFunction(K_NEW_ARRAY);
    else if (arrayFunction) a = yield* this.getArrayFunction(this.pgm.table[it.tokenAddress].type);
    else {
      const v = it.lookupVariable();
      a = v.getArray();
      const size = v.getArraySize();
      if (a !== null && a.length !== size) {
        v.setArray(a.slice(0, size));
        a = v.getArray();
      }
    }
    if (a === null) it.error('Array expected');
    return a;
  }
  *getNumericArray() { return (yield* this.getArray()).map((v) => v.getValue()); }
  *getFirstArray() { this.interp.getLeftParen(); return yield* this.getNumericArray(); }
  *getNextArray() { this.interp.getComma(); return yield* this.getNumericArray(); }
  *getLastArray() {
    this.interp.getComma();
    const a = yield* this.getNumericArray();
    this.interp.getRightParen();
    return a;
  }

  newVariableArray(values) {
    return values.map((x) => typeof x === 'string' ? Variable.string(x) : Variable.num(x));
  }

  checkIndex(index, lower, upper) {
    if (index < lower || index > upper)
      this.interp.error('Index (' + index + ') is outside of the ' + lower + '-' + upper + ' range');
  }

  isStringArg() {
    const code = this.pgm.code, it = this.interp;
    const nextToken = code[it.pc + 1];
    const tok = nextToken & 0xff;
    if (tok === STRING_CONSTANT || tok === STRING_FUNCTION) return true;
    if (tok === VARIABLE_FUNCTION && it.isString(it.pc + 1)) return true;
    if (tok !== WORD) return false;
    const v = it.lookupVariableAt(nextToken >> TOK_SHIFT);
    if (v === null) return false;
    const type = v.getType();
    if (type !== V_ARRAY) return v.getType() === V_STRING;
    const array = v.getArray();
    if (array.length === 0 || it.nextNextToken() === DOT) return false;
    return array[0].getType() === V_STRING;
  }

  /* ---- string helpers shared by the interpreter's `s.method()` syntax ---- */
  *getStringFunctionArg(s) {
    if (s === null) {
      s = yield* this.getFirstString();
      this.interp.getComma();
    } else
      this.interp.getLeftParen();
    return s;
  }

  *substring(s) {
    const it = this.interp;
    s = yield* this.getStringFunctionArg(s);
    const index1 = toInt(yield* it.getExpression());
    let index2 = s.length;
    if (it.nextToken() === COMMA) index2 = toInt(yield* this.getLastArg());
    else it.getRightParen();
    if (index1 > index2) it.error('beginIndex>endIndex');
    this.checkIndex(index1, 0, s.length);
    this.checkIndex(index2, 0, s.length);
    return s.substring(index1, index2);
  }

  *indexOf(s1) {
    const it = this.interp;
    s1 = yield* this.getStringFunctionArg(s1);
    const s2 = yield* this.getString();
    let fromIndex = 0;
    if (it.nextToken() === COMMA) {
      fromIndex = toInt(yield* this.getLastArg());
      this.checkIndex(fromIndex, 0, s1.length - 1);
    } else
      it.getRightParen();
    return fromIndex === 0 ? s1.indexOf(s2) : s1.indexOf(s2, fromIndex);
  }

  *replace(s1) {
    s1 = yield* this.getStringFunctionArg(s1);
    const s2 = yield* this.getString();
    const s3 = yield* this.getLastString();
    if (s2.length === 1) {
      let sb = '';
      for (let i = 0; i < s1.length; i++) {
        const c = s1.charAt(i);
        sb += c === s2.charAt(0) ? s3 : c;
      }
      return sb;
    }
    try {
      return javaReplaceAll(s1, s2, s3);
    } catch (e) {
      if (isInternalFault(e)) throw e;
      this.interp.error('' + (e && e.javaMessage ? e.javaMessage : e));
      return null;
    }
  }

  /* Functions.getFirstArrayVariable / getLastArrayVariable / getArrayVariable */
  getArrayVariable() {
    const it = this.interp;
    it.getToken();
    if (it.token !== WORD) it.error('Variable expected');
    let v = it.lookupLocalVariable(it.tokenAddress);
    if (v === null) v = it.pushNew(it.tokenAddress, 0.0, null, it);
    return v;
  }
  getFirstArrayVariable() { this.interp.getLeftParen(); return this.getArrayVariable(); }
  getLastArrayVariable() {
    this.interp.getComma();
    const v = this.getArrayVariable();
    this.interp.getRightParen();
    return v;
  }
  *getStringArray() {
    return (yield* this.getArray()).map((v) => {
      const s = v.getString();
      return s === null ? javaDouble(v.getValue()) : s;
    });
  }
  /* Functions.isArrayArg: the next argument is a whole array (not an element). */
  isArrayArg() {
    const it = this.interp;
    const nextToken = this.pgm.code[it.pc + 1];
    const tok = nextToken & 0xff;
    if (tok === ARRAY_FUNCTION) return true;
    if (tok !== WORD) return false;
    const v = it.lookupVariableAt(nextToken >> TOK_SHIFT);
    if (v === null) return false;
    return v.getType() === V_ARRAY && this.pgm.code[it.pc + 2] !== LSQ;
  }

  *matches(str) {
    str = yield* this.getStringFunctionArg(str);
    const regex = yield* this.getString();
    this.interp.getRightParen();
    try {
      return javaRegex(regex, true).test(str) ? 1.0 : 0.0;
    } catch (e) {
      if (isInternalFault(e)) throw e;
      this.interp.error('' + (e && e.javaMessage ? e.javaMessage : e));
      return 0.0;
    }
  }
}

/* ======================================================================================
 * java.util.regex -> RegExp.
 * Written from the java.util.regex.Pattern documentation (not from its source): a Java pattern is parsed into
 * a small tree and re-emitted as a RegExp source. Every flag is resolved here ((?i) ASCII or Unicode case,
 * (?s), (?m), (?d), (?x), (?U)), so the RegExp itself only ever gets the `u` flag (+ `g`/`y`). What JavaScript
 * lacks is built from lookaheads: \Z, \A, ^ and $ of the line modes, possessive quantifiers and atomic
 * groups (`(?=(X))\N`), class intersection (`(?=B)A`). Errors are the java.util.regex.PatternSyntaxException
 * messages with Java's index and caret.
 * ==================================================================================== */
const JX_LT = '\\n\\r\\u0085\\u2028\\u2029';   // line terminators, as the body of a class
function jxErr(pattern, desc, index) {
  return { javaMessage: 'java.util.regex.PatternSyntaxException: ' + desc + ' near index ' + index + '\n' + pattern +
    (index >= 0 && index < pattern.length ? '\n' + ' '.repeat(index) + '^' : '') };
}
const jxHex = (cp) => '\\u{' + cp.toString(16) + '}';
const jxLit = (cp) => ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) ? String.fromCharCode(cp) : jxHex(cp);
const jxIsDigit = (c) => c >= '0' && c <= '9';
const jxIsLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const jxIsHex = (c) => jxIsDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

/* code point sets: sorted [lo, hi] lists */
function jxNorm(r) {
  r = r.slice().sort((a, b) => a[0] - b[0]);
  const o = [];
  for (const x of r) {
    const l = o[o.length - 1];
    if (l && x[0] <= l[1] + 1) { if (x[1] > l[1]) l[1] = x[1]; } else o.push([x[0], x[1]]);
  }
  return o;
}
const jxRangesBody = (r) => jxNorm(r).map(([a, b]) => (a === b ? jxLit(a) : jxLit(a) + '-' + jxLit(b))).join('');
const jxFromBody = (body) => ({ src: '[' + body + ']', body });
const jxFromRanges = (r) => jxFromBody(jxRangesBody(r));
/* A matcher is { src: a RegExp source matching exactly one code point, body: its class body or null }. */
function jxNegate(m) {
  if (m.body !== null) return { src: '[^' + m.body + ']', body: null };
  return { src: '(?:(?!' + m.src + ')[^])', body: null };
}
function jxUnion(ms) {
  if (ms.every((m) => m.body !== null)) return jxFromBody(ms.map((m) => m.body).join(''));
  const bodies = ms.filter((m) => m.body !== null).map((m) => m.body).join('');
  const parts = ms.filter((m) => m.body === null).map((m) => m.src);
  if (bodies) parts.unshift('[' + bodies + ']');
  return { src: '(?:' + parts.join('|') + ')', body: null };
}
function jxIntersect(ms) {
  if (ms.length === 1) return ms[0];
  return { src: '(?:' + ms.slice(1).map((m) => '(?=' + m.src + ')').join('') + ms[0].src + ')', body: null };
}

const JX_ASCII = {
  Lower: [[97, 122]], Upper: [[65, 90]], ASCII: [[0, 127]], Alpha: [[65, 90], [97, 122]], Digit: [[48, 57]],
  Alnum: [[48, 57], [65, 90], [97, 122]], Punct: [[33, 47], [58, 64], [91, 96], [123, 126]], Graph: [[33, 126]],
  Print: [[32, 126]], Blank: [[9, 9], [32, 32]], Cntrl: [[0, 31], [127, 127]],
  XDigit: [[48, 57], [65, 70], [97, 102]], Space: [[9, 13], [32, 32]],
};
/* the same names under UNICODE_CHARACTER_CLASS */
const JX_UNICODE_POSIX = {
  Lower: '\\p{Lowercase}', Upper: '\\p{Uppercase}', ASCII: '\\x00-\\x7F', Alpha: '\\p{Alphabetic}', Digit: '\\p{Nd}',
  Alnum: '\\p{Alphabetic}\\p{Nd}', Punct: '\\p{P}', Graph: null, Print: null, Blank: '\\p{Zs}\\t', Cntrl: '\\p{Cc}',
  XDigit: '\\p{Nd}\\p{Hex_Digit}', Space: '\\p{White_Space}',
};
const JX_WORD_U = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}';
const JX_H = [[9, 9], [32, 32], [0xA0, 0xA0], [0x1680, 0x1680], [0x180E, 0x180E], [0x2000, 0x200A], [0x202F, 0x202F], [0x205F, 0x205F], [0x3000, 0x3000]];
const JX_V = [[10, 13], [0x85, 0x85], [0x2028, 0x2029]];

/* \d \D \w \W \s \S \h \H \v \V */
function jxPredef(ch, f) {
  switch (ch) {
    case 'd': return f.U ? jxFromBody('\\p{Nd}') : jxFromBody('0-9');
    case 'w': return f.U ? jxFromBody(JX_WORD_U) : jxFromBody('A-Za-z0-9_');
    case 's': return f.U ? jxFromBody('\\p{White_Space}') : jxFromRanges([[9, 13], [32, 32]]);
    case 'h': return jxFromRanges(JX_H);
    case 'v': return jxFromRanges(JX_V);
    default: return jxNegate(jxPredef(ch.toLowerCase(), f));
  }
}

const JX_CATEGORIES = new Set(['L', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'LC', 'M', 'Mn', 'Mc', 'Me', 'N', 'Nd', 'Nl', 'No', 'P', 'Pc', 'Pd', 'Ps',
  'Pe', 'Pi', 'Pf', 'Po', 'S', 'Sm', 'Sc', 'Sk', 'So', 'Z', 'Zs', 'Zl', 'Zp', 'C', 'Cc', 'Cf', 'Cs', 'Co', 'Cn']);
const JX_BLOCKS = { basiclatin: [0, 0x7F], latin1supplement: [0x80, 0xFF], latinextendeda: [0x100, 0x17F], latinextendedb: [0x180, 0x24F],
  ipaextensions: [0x250, 0x2AF], spacingmodifierletters: [0x2B0, 0x2FF], combiningdiacriticalmarks: [0x300, 0x36F], greek: [0x370, 0x3FF],
  greekandcoptic: [0x370, 0x3FF], cyrillic: [0x400, 0x4FF], armenian: [0x530, 0x58F], hebrew: [0x590, 0x5FF], arabic: [0x600, 0x6FF],
  thai: [0xE00, 0xE7F], generalpunctuation: [0x2000, 0x206F], currencysymbols: [0x20A0, 0x20CF], letterlikesymbols: [0x2100, 0x214F],
  arrows: [0x2190, 0x21FF], mathematicaloperators: [0x2200, 0x22FF], boxdrawing: [0x2500, 0x257F], hiragana: [0x3040, 0x309F],
  katakana: [0x30A0, 0x30FF], cjkunifiedideographs: [0x4E00, 0x9FFF], hangulsyllables: [0xAC00, 0xD7AF], privateusearea: [0xE000, 0xF8FF],
  halfwidthandfullwidthforms: [0xFF00, 0xFFEF], emoticons: [0x1F600, 0x1F64F] };
const jxJsOk = (s) => { try { new RegExp(s, 'u'); return true; } catch (e) { return false; } };
function jxScriptName(s) {   // Java matches script names case-insensitively, JS wants "Latin" / "Old_Italic"
  const cands = [s, s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('_')];
  for (const c of cands) if (jxJsOk('\\p{Script=' + c + '}')) return '\\p{Script=' + c + '}';
  return null;
}
const JX_JAVA_PROPS = {
  javaLowerCase: '\\p{Lowercase}', javaUpperCase: '\\p{Uppercase}', javaTitleCase: '\\p{Lt}', javaAlphabetic: '\\p{Alphabetic}',
  javaLetter: '\\p{L}', javaDigit: '\\p{Nd}', javaLetterOrDigit: '\\p{L}\\p{Nd}', javaSpaceChar: '\\p{Z}', javaIdeographic: '\\p{Ideographic}',
  javaISOControl: '\\x00-\\x1F\\x7F-\\x9F', javaDefined: '\\P{Cn}', javaJavaIdentifierStart: '\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}',
  javaJavaIdentifierPart: '\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}\\p{Nd}\\p{Mn}\\p{Mc}\\x00-\\x08\\x0E-\\x1B\\x7F-\\x9F\\p{Cf}',
};
/* \p{name} -> matcher, or null for a name Java rejects */
function jxProperty(name, f) {
  if (Object.prototype.hasOwnProperty.call(JX_ASCII, name)) {
    if (!f.U) return jxFromRanges(JX_ASCII[name]);
    const u = JX_UNICODE_POSIX[name];
    if (u !== null) return jxFromBody(u);
    return name === 'Graph' ? jxNegate(jxFromBody('\\p{White_Space}\\p{Cc}\\p{Cs}\\p{Cn}')) : jxNegate(jxFromBody('\\p{Zl}\\p{Zp}\\p{Cc}\\p{Cs}\\p{Cn}'));
  }
  if (name === 'javaWhitespace')
    return { src: '(?:(?![\\u00a0\\u2007\\u202f])[\\t-\\r\\x1c-\\x1f\\p{Zs}\\p{Zl}\\p{Zp}])', body: null };
  if (Object.prototype.hasOwnProperty.call(JX_JAVA_PROPS, name)) return jxFromBody(JX_JAVA_PROPS[name]);
  if (JX_CATEGORIES.has(name)) return jxFromBody('\\p{' + name + '}');
  let m;
  if ((m = /^(?:In|(?:blk|block)=)(.+)$/.exec(name)) !== null) {
    const r = JX_BLOCKS[m[1].toLowerCase().replace(/[-_ ]/g, '')];
    return r ? jxFromRanges([r]) : null;
  }
  if ((m = /^(?:gc|general_category)=(.+)$/.exec(name)) !== null) return JX_CATEGORIES.has(m[1]) && jxJsOk('\\p{gc=' + m[1] + '}') ? jxFromBody('\\p{' + m[1] + '}') : null;
  if ((m = /^(?:sc|script)=(.+)$/.exec(name)) !== null) { const s = jxScriptName(m[1]); return s ? jxFromBody(s) : null; }
  if (name.startsWith('Is')) {
    const rest = name.slice(2);
    if (JX_CATEGORIES.has(rest)) return jxFromBody('\\p{' + rest + '}');
    const alias = { Alpha: 'Alphabetic', Letter: 'L', Titlecase: 'Lt', Punctuation: 'P', Control: 'Cc', Digit: 'Nd', WhiteSpace: 'White_Space', HexDigit: 'Hex_Digit', JoinControl: 'Join_Control',
      NoncharacterCodePoint: 'Noncharacter_Code_Point', Assigned: null };
    if (rest === 'Assigned') return jxFromBody('\\P{Cn}');
    const bin = Object.prototype.hasOwnProperty.call(alias, rest) ? alias[rest] : rest;
    if (/^(Alphabetic|Ideographic|Lowercase|Uppercase|White_Space|Hex_Digit|Join_Control|Noncharacter_Code_Point|Emoji\w*|Extended_Pictographic|ASCII_Hex_Digit|Dash|Diacritic|Math|Quotation_Mark|Radical|Soft_Dotted|Unified_Ideograph|Variation_Selector|Default_Ignorable_Code_Point|Case_Ignorable|Cased|ID_Start|ID_Continue|XID_Start|XID_Continue|Bidi_Control|Bidi_Mirrored|Deprecated|Extender|Grapheme_Base|Grapheme_Extend|Hyphen|IDS_Binary_Operator|IDS_Trinary_Operator|Logical_Order_Exception|Pattern_Syntax|Pattern_White_Space|Regional_Indicator|Sentence_Terminal|Terminal_Punctuation)$/.test(bin) && jxJsOk('\\p{' + bin + '}'))
      return jxFromBody('\\p{' + bin + '}');
    if (JX_CATEGORIES.has(bin)) return jxFromBody('\\p{' + bin + '}');
    const s = jxScriptName(rest);
    return s ? jxFromBody(s) : null;
  }
  return null;
}

/* case-insensitive matching: (?i) = ASCII letters only, (?iu) / (?U) = Unicode simple case folding */
const JX_ODD_CASE = [0x4B, 0x6B, 0x212A, 0x53, 0x73, 0x17F, 0xC5, 0xE5, 0x212B, 0x3A3, 0x3C3, 0x3C2, 0xB5, 0x39C, 0x3BC, 0x1C4, 0x1C5, 0x1C6, 0x1C7, 0x1C8, 0x1C9,
  0x1CA, 0x1CB, 0x1CC, 0x1F1, 0x1F2, 0x1F3, 0x392, 0x3B2, 0x3D0, 0x398, 0x3B8, 0x3D1, 0x3F4, 0x3A6, 0x3C6, 0x3D5, 0x3A0, 0x3C0, 0x3D6, 0x39A, 0x3BA, 0x3F0, 0x3A1, 0x3C1,
  0x3F1, 0x395, 0x3B5, 0x3F5, 0x1E60, 0x1E61, 0x1E9B, 0x399, 0x3B9, 0x345, 0x1FBE, 0x1E9E, 0xDF];
const jxCaseMemo = new Map();
function jxVariants(cp, level) {
  if (level === 0) return [cp];
  if (level === 1) return cp >= 65 && cp <= 90 ? [cp, cp + 32] : cp >= 97 && cp <= 122 ? [cp, cp - 32] : [cp];
  let v = jxCaseMemo.get(cp);
  if (v) return v;
  const s = String.fromCodePoint(cp);
  const cands = new Set([cp]);
  for (const t of [s.toLowerCase(), s.toUpperCase()]) if (t.length === (cp > 0xFFFF ? 2 : 1)) cands.add(t.codePointAt(0));
  for (const c of JX_ODD_CASE) cands.add(c);
  const rx = new RegExp('^' + jxHex(cp) + '$', 'iu');
  v = [...cands].filter((c) => c === cp || rx.test(String.fromCodePoint(c)));
  jxCaseMemo.set(cp, v);
  return v;
}
function jxCaseRanges(lo, hi, level, out) {
  out.push([lo, hi]);
  if (level === 0) return;
  const a1 = Math.max(lo, 65), a2 = Math.min(hi, 90);
  if (a1 <= a2) out.push([a1 + 32, a2 + 32]);
  const b1 = Math.max(lo, 97), b2 = Math.min(hi, 122);
  if (b1 <= b2) out.push([b1 - 32, b2 - 32]);
  if (level === 2 && hi - lo <= 3000)
    for (let c = lo; c <= hi; c++) for (const x of jxVariants(c, 2)) if (x !== c) out.push([x, x]);
}

class JxParser {
  constructor(pattern) {
    this.p = pattern; this.n = pattern.length; this.i = 0;
    this.f = { i: false, u: false, U: false, s: false, m: false, d: false, x: false };
    this.ngroups = 0; this.names = new Map(); this.sticky = false; this.depth = 0; this.firstSeq = true;
  }
  err(desc, idx) { return jxErr(this.p, desc, idx); }
  ci() { return this.f.i ? (this.f.u || this.f.U ? 2 : 1) : 0; }
  /* COMMENTS mode: white space and #-comments are skipped (also inside a class, as Java does) */
  skipx() {
    if (!this.f.x) return;
    while (this.i < this.n) {
      const c = this.p[this.i];
      if (c === ' ' || (c >= '\t' && c <= '\r')) this.i++;
      else if (c === '#') { while (this.i < this.n && !/[\n\r\u0085\u2028\u2029]/.test(this.p[this.i])) this.i++; }
      else break;
    }
  }

  parseTop() {
    const node = this.parseAlt();
    if (this.i < this.n) throw this.err("Unmatched closing ')'", this.i - 1);
    return node;
  }
  parseAlt() {
    const alts = [this.parseSeq()];
    while (this.i < this.n && this.p[this.i] === '|') { this.i++; alts.push(this.parseSeq()); }
    return alts.length === 1 ? alts[0] : { t: 'alt', k: alts };
  }
  parseSeq() {
    const k = [];
    const first = this.firstSeq && this.depth === 0;
    this.firstSeq = false;
    for (;;) {
      this.skipx();
      if (this.i >= this.n) break;
      const c = this.p[this.i];
      if (c === '|' || c === ')') break;
      let atom = this.parseAtom(first && k.length === 0);
      if (atom === null) continue;
      if (atom.quote) {   // \Q..\E: a quantifier after it applies to the last quoted character
        if (atom.k.length === 0) continue;
        for (let j = 0; j < atom.k.length - 1; j++) k.push(atom.k[j]);
        atom = atom.k[atom.k.length - 1];
      }
      k.push(this.parseQuant(atom));
    }
    return { t: 'seq', k };
  }

  parseAtom(atStart) {
    const c = this.p[this.i], f = this.f;
    switch (c) {
      case '(': return this.parseGroup();
      case '[': return { t: 'cls', m: this.parseClass() };
      case '.': this.i++; return { t: 'raw', src: f.s ? '[^]' : f.d ? '[^\\n]' : '[^' + JX_LT + ']', atom: true };
      case '^': this.i++; return { t: 'raw', src: f.m ? (f.d ? '(?=[^])(?:(?<![^])|(?<=\\n))' : '(?=[^])(?:(?<![^])|(?<=[\\n\\u0085\\u2028\\u2029])|(?<=\\r)(?!\\n))') : '(?<![^])' };
      case '$': this.i++; return { t: 'raw', src: this.eol() };
      case '\\': return this.parseEscape(atStart);
      case '*': case '+': case '?': throw this.err("Dangling meta character '" + c + "'", this.i);
      case '{': { this.braces(); return { t: 'raw', src: '(?:)' }; }   // Java: a counted closure with no atom matches the empty string
      default: {
        const cp = this.p.codePointAt(this.i);
        this.i += cp > 0xFFFF ? 2 : 1;
        return { t: 'lit', cp, ci: this.ci() };
      }
    }
  }
  /* $ and \Z: before a final line terminator or at the end; with (?m) before any terminator; never between \r and \n */
  eol(forceEnd) {
    const f = this.f, lt = f.d ? '\\n' : JX_LT;
    if (f.m && !forceEnd) return '(?:(?!(?<=\\r)\\n)(?=[' + lt + ']|(?![^])))';
    return '(?:(?!(?<=\\r)\\n)(?=(?:' + (f.d ? '' : '\\r\\n|') + '[' + lt + '])?(?![^])))';
  }

  /* a counted closure at this position: [min, max] (consumed), or an error as Java reports it */
  braces() {
    let j = this.i + 1;
    const s = j;
    while (j < this.n && jxIsDigit(this.p[j])) j++;
    if (j === s) throw this.err('Illegal repetition', j);
    const min = parseInt(this.p.slice(s, j), 10);
    let max = min;
    if (this.p[j] === ',') {
      j++;
      const s2 = j;
      while (j < this.n && jxIsDigit(this.p[j])) j++;
      max = j === s2 ? Infinity : parseInt(this.p.slice(s2, j), 10);
    }
    if (this.p[j] !== '}') throw this.err('Unclosed counted closure', j);
    if (max < min) throw this.err('Illegal repetition range', j);
    this.i = j + 1;
    return [min, max];
  }
  parseQuant(atom) {
    this.skipx();
    const c = this.p[this.i];
    let min, max;
    if (c === '*') { this.i++; min = 0; max = Infinity; }
    else if (c === '+') { this.i++; min = 1; max = Infinity; }
    else if (c === '?') { this.i++; min = 0; max = 1; }
    else if (c === '{') [min, max] = this.braces();
    else return atom;
    let mode = 'greedy';
    if (this.p[this.i] === '?') { this.i++; mode = 'lazy'; }
    else if (this.p[this.i] === '+') { this.i++; mode = 'possessive'; }
    return { t: 'q', k: atom, min, max, mode };
  }

  parseGroup() {
    const p = this.p;
    this.i++;
    const saved = Object.assign({}, this.f);
    let node, kind = 'cap', name = null, behind = false, neg = false, scoped = false;
    if (p[this.i] === '?') {
      this.i++;
      if (this.i >= this.n) throw this.err('Unknown inline modifier', this.i);
      const c = p[this.i];
      if (c === ':') { this.i++; kind = 'ncg'; }
      else if (c === '=' || c === '!') { this.i++; kind = 'look'; neg = c === '!'; }
      else if (c === '>') { this.i++; kind = 'atomic'; }
      else if (c === '<' && (p[this.i + 1] === '=' || p[this.i + 1] === '!')) { kind = 'look'; behind = true; neg = p[this.i + 1] === '!'; this.i += 2; }
      else if (c === '<') {
        this.i++;
        if (!(this.i < this.n && jxIsLetter(p[this.i]))) throw this.err('capturing group name does not start with a Latin letter', this.i);
        let j = this.i;
        while (j < this.n && (jxIsLetter(p[j]) || jxIsDigit(p[j]))) j++;
        if (p[j] !== '>') throw this.err("named capturing group is missing trailing '>'", j);
        name = p.slice(this.i, j);
        if (this.names.has(name)) throw this.err('Named capturing group <' + name + '> is already defined', j);
        this.i = j + 1;
      } else {
        let on = true;
        const flags = Object.assign({}, this.f);
        for (;;) {
          if (this.i >= this.n) throw this.err('Unknown inline modifier', this.i);
          const ch = p[this.i];
          if (ch === '-') on = false;
          else if ('idmsuxU'.indexOf(ch) >= 0) flags[ch] = on;
          else if (ch === ')') { this.i++; this.f = flags; return null; }
          else if (ch === ':') { this.i++; this.f = flags; scoped = true; kind = 'ncg'; break; }
          else throw this.err('Unknown inline modifier', this.i);
          this.i++;
        }
      }
    }
    void scoped;
    let idx = 0;
    if (kind === 'cap') { idx = ++this.ngroups; if (name !== null) this.names.set(name, idx); }
    this.depth++;
    const body = this.parseAlt();
    this.depth--;
    if (this.i >= this.n || p[this.i] !== ')') throw this.err('Unclosed group', this.n);
    this.i++;
    this.f = saved;
    if (kind === 'cap') node = { t: 'grp', n: idx, k: body };
    else if (kind === 'ncg') node = { t: 'ncg', k: body };
    else if (kind === 'look') node = { t: 'look', behind, neg, k: body };
    else node = { t: 'atomic', k: body };
    return node;
  }

  /* after a backslash (this.i on the char after it) in a pattern, outside a class */
  parseEscape(atStart) {
    const p = this.p;
    this.i++;
    if (this.i >= this.n) throw this.err('Unescaped trailing backslash', this.n);
    const c = p[this.i], f = this.f;
    switch (c) {
      case 'd': case 'D': case 'w': case 'W': case 's': case 'S': case 'h': case 'H': case 'v': case 'V':
        this.i++; return { t: 'cls', m: jxPredef(c, f) };
      case 'p': case 'P': return { t: 'cls', m: this.parseProp(c === 'P') };
      case 'b': this.i++; return { t: 'raw', src: '\\b' };
      case 'B': this.i++; return { t: 'raw', src: '\\B' };
      case 'A': this.i++; return { t: 'raw', src: '(?<![^])' };
      case 'z': this.i++; return { t: 'raw', src: '(?![^])' };
      case 'Z': this.i++; return { t: 'raw', src: this.eol(true) };
      case 'G':
        this.i++;
        if (!atStart) throw this.err('\\G is only supported at the start of a pattern in the browser', this.i - 1);
        this.sticky = true;
        return null;
      case 'R': this.i++; return { t: 'raw', src: '(?:\\r\\n|[\\n\\x0B\\f\\r\\u0085\\u2028\\u2029])', atom: true };
      case 'X': this.i++; return { t: 'raw', src: '(?:\\r\\n|[^]\\p{M}*)', atom: true };
      case 'Q': {
        this.i++;
        let end = p.indexOf('\\E', this.i);
        if (end < 0) end = this.n;
        const k = [];
        for (let j = this.i; j < end;) { const cp = p.codePointAt(j); j += cp > 0xFFFF ? 2 : 1; k.push({ t: 'lit', cp, ci: this.ci() }); }
        this.i = Math.min(this.n, end + 2);
        return { t: 'seq', k, quote: true };
      }
      case 'k': {
        this.i++;
        if (p[this.i] !== '<') throw this.err("\\k is not followed by '<' for named capturing group", this.i);
        let j = this.i + 1;
        while (j < this.n && (jxIsLetter(p[j]) || jxIsDigit(p[j]))) j++;
        if (p[j] !== '>') throw this.err("named capturing group is missing trailing '>'", j);
        const name = p.slice(this.i + 1, j);
        if (!this.names.has(name)) throw this.err('named capturing group <' + name + '> does not exist', j);
        this.i = j + 1;
        return { t: 'ref', n: this.names.get(name) };
      }
      default:
        if (c >= '1' && c <= '9') {
          let num = c.charCodeAt(0) - 48;
          this.i++;
          while (this.i < this.n && jxIsDigit(p[this.i])) {
            const nn = num * 10 + (p.charCodeAt(this.i) - 48);
            if (nn > this.ngroups) break;
            num = nn; this.i++;
          }
          return num > this.ngroups ? { t: 'raw', src: '(?!)' } : { t: 'ref', n: num };
        }
        return { t: 'lit', cp: this.charEscape(), ci: this.ci() };
    }
  }
  /* \p{..} / \pL / \P{..}: this.i is on the p */
  parseProp(neg) {
    const p = this.p;
    this.i++;
    if (this.i >= this.n) throw this.err('Unknown character property name {\u0000}', this.n);
    let name, close;
    if (p[this.i] === '{') {
      const j = p.indexOf('}', this.i);
      if (j < 0) throw this.err('Unclosed character family', this.n);
      name = p.slice(this.i + 1, j); close = j; this.i = j + 1;
    } else {
      const cp = p.codePointAt(this.i);
      name = String.fromCodePoint(cp); this.i += cp > 0xFFFF ? 2 : 1; close = this.i - 1;
    }
    const m = jxProperty(name, this.f);
    if (m === null) throw this.err('Unknown character property name {' + name + '}', close);
    return neg ? jxNegate(m) : m;
  }
  /* A single-character escape (this.i on the char after the backslash): its code point. */
  charEscape() {
    const p = this.p, c = p[this.i];
    switch (c) {
      case 't': this.i++; return 9;
      case 'n': this.i++; return 10;
      case 'r': this.i++; return 13;
      case 'f': this.i++; return 12;
      case 'a': this.i++; return 7;
      case 'e': this.i++; return 27;
      case '0': {
        let j = this.i + 1;
        const oct = (x) => x !== undefined && x >= '0' && x <= '7';
        if (!oct(p[j])) throw this.err('Illegal octal escape sequence', j);
        let v = p.charCodeAt(j) - 48; const first = v; j++;
        if (oct(p[j])) { v = v * 8 + (p.charCodeAt(j) - 48); j++; if (first <= 3 && oct(p[j])) { v = v * 8 + (p.charCodeAt(j) - 48); j++; } }
        this.i = j; return v;
      }
      case 'x': {
        let j = this.i + 1;
        if (p[j] === '{') {
          const s = ++j;
          while (j < this.n && jxIsHex(p[j])) j++;
          if (j === s || p[j] !== '}') throw this.err('Illegal hexadecimal escape sequence', j);
          const v = parseInt(p.slice(s, j), 16);
          if (v > 0x10FFFF || s + 8 < j) throw this.err('Hexadecimal codepoint is too big', j - 1);
          this.i = j + 1; return v;
        }
        if (!(jxIsHex(p[j] || '') && jxIsHex(p[j + 1] || ''))) throw this.err('Illegal hexadecimal escape sequence', jxIsHex(p[j] || '') ? j + 1 : j);
        this.i = j + 2; return parseInt(p.slice(j, j + 2), 16);
      }
      case 'u': {
        const read = (at) => {
          for (let q = at; q < at + 4; q++) if (!jxIsHex(p[q] || '')) throw this.err('Illegal Unicode escape sequence', q);
          return parseInt(p.slice(at, at + 4), 16);
        };
        let v = read(this.i + 1);
        this.i += 5;
        if (v >= 0xD800 && v <= 0xDBFF && p[this.i] === '\\' && p[this.i + 1] === 'u' && [0, 1, 2, 3].every((d) => jxIsHex(p[this.i + 2 + d] || ''))) {
          const lo = parseInt(p.slice(this.i + 2, this.i + 6), 16);
          if (lo >= 0xDC00 && lo <= 0xDFFF) { v = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00); this.i += 6; }
        }
        return v;
      }
      case 'c': {
        this.i++;
        if (this.i >= this.n) throw this.err('Illegal control escape sequence', this.i - 1);
        const v = p.charCodeAt(this.i) ^ 64;
        this.i++; return v;
      }
      case 'N': {
        const close = p.indexOf('}', this.i);
        const end = close < 0 ? this.n : close;
        throw this.err('Unknown character name [' + p.slice(this.i + 2, end) + ']', close < 0 ? this.n : close);
      }
      default:
        if (jxIsLetter(c) || jxIsDigit(c)) throw this.err('Illegal/unsupported escape sequence', this.i);
        {
          const cp = p.codePointAt(this.i);
          this.i += cp > 0xFFFF ? 2 : 1;
          return cp;
        }
    }
  }

  /* [ ... ] with nesting, && and ^; this.i on the [ . Returns a matcher. */
  parseClass() {
    const p = this.p, level = this.ci(), f = this.f;
    this.i++;
    let neg = false;
    if (p[this.i] === '^') { neg = true; this.i++; }
    const operands = [];
    let items = [], first = true;
    for (;;) {
      this.skipx();
      if (this.i >= this.n) throw this.err('Unclosed character class', this.n - 1);
      const c = p[this.i];
      if (c === ']' && !(first && items.length === 0 && operands.length === 0)) { this.i++; break; }
      first = false;
      if (c === '[') { items.push({ k: 'n', m: this.parseClass() }); continue; }
      if (c === '&' && p[this.i + 1] === '&') { this.i += 2; operands.push(items); items = []; continue; }
      let lo;
      if (c === '\\' && p[this.i + 1] === 'Q') {
        let end = p.indexOf('\\E', this.i + 2);
        if (end < 0) end = this.n;
        for (let j = this.i + 2; j < end;) { const cp = p.codePointAt(j); j += cp > 0xFFFF ? 2 : 1; items.push({ k: 'c', cp }); }
        this.i = Math.min(this.n, end + 2);
        continue;
      }
      lo = this.classAtom();
      if (lo.cp !== undefined && p[this.i] === '-' && this.i + 1 < this.n && p[this.i + 1] !== ']') {
        this.i++;
        const hi = this.classAtom();
        if (hi.cp === undefined || hi.cp < lo.cp) throw this.err('Illegal character range', this.i - 1);
        items.push({ k: 'r', lo: lo.cp, hi: hi.cp });
      } else items.push(lo.cp !== undefined ? { k: 'c', cp: lo.cp } : { k: 'n', m: lo.m });
    }
    operands.push(items);
    const ms = operands.filter((o) => o.length > 0).map((o) => {
      const ranges = [], rest = [];
      for (const it of o) {
        if (it.k === 'c') jxCaseRanges(it.cp, it.cp, level, ranges);
        else if (it.k === 'r') jxCaseRanges(it.lo, it.hi, level, ranges);
        else rest.push(it.m);
      }
      return jxUnion([jxFromRanges(ranges)].concat(rest));
    });
    let m = ms.length === 0 ? jxFromBody('') : jxIntersect(ms);
    void f;
    if (neg) m = jxNegate(m);
    return m;
  }
  /* one member of a class: { cp } or { m: matcher } */
  classAtom() {
    const p = this.p;
    if (p[this.i] !== '\\') {
      const cp = p.codePointAt(this.i);
      this.i += cp > 0xFFFF ? 2 : 1;
      return { cp };
    }
    this.i++;
    if (this.i >= this.n) throw this.err('Unescaped trailing backslash', this.n);
    const c = p[this.i];
    if ('dDwWsShHvV'.indexOf(c) >= 0) { this.i++; return { m: jxPredef(c, this.f) }; }
    if (c === 'p' || c === 'P') return { m: this.parseProp(c === 'P') };
    if (c >= '1' && c <= '9') throw this.err('Illegal/unsupported escape sequence', this.i);
    return { cp: this.charEscape() };
  }
}

/* second step: number the groups the RegExp will have (Java groups plus the helpers of atomic / possessive) */
function jxNumber(node, st) {
  switch (node.t) {
    case 'seq': case 'alt': for (const k of node.k) jxNumber(k, st); break;
    case 'grp': node.js = ++st.cnt; st.jmap[node.n] = node.js; jxNumber(node.k, st); break;
    case 'ncg': case 'look': jxNumber(node.k, st); break;
    case 'atomic': node.h = ++st.cnt; jxNumber(node.k, st); break;
    case 'q': if (node.mode === 'possessive') node.h = ++st.cnt; jxNumber(node.k, st); break;
    default: break;
  }
}
function jxQuantifier(q) {
  if (q.min === 0 && q.max === Infinity) return '*';
  if (q.min === 1 && q.max === Infinity) return '+';
  if (q.min === 0 && q.max === 1) return '?';
  if (q.max === Infinity) return '{' + q.min + ',}';
  return q.min === q.max ? '{' + q.min + '}' : '{' + q.min + ',' + q.max + '}';
}
function jxEmit(node, st) {
  switch (node.t) {
    case 'lit': {
      const v = jxVariants(node.cp, node.ci);
      return v.length > 1 ? '[' + v.map(jxLit).join('') + ']' : jxLit(node.cp);
    }
    case 'raw': return node.src;
    case 'cls': return node.m.src;
    case 'seq': return node.k.map((k) => jxEmit(k, st)).join('');
    case 'alt': return node.k.map((k) => jxEmit(k, st)).join('|');
    case 'grp': return '(' + jxEmit(node.k, st) + ')';
    case 'ncg': return '(?:' + jxEmit(node.k, st) + ')';
    case 'look': return '(?' + (node.behind ? '<' : '') + (node.neg ? '!' : '=') + jxEmit(node.k, st) + ')';
    case 'atomic': return '(?=(' + jxEmit(node.k, st) + '))(?:\\' + node.h + ')';
    case 'ref': return '(?:\\' + st.jmap[node.n] + ')';
    case 'q': {
      const k = node.k;
      let inner = jxEmit(k, st);
      if (k.t === 'seq' || k.t === 'alt' || k.t === 'look' || k.t === 'atomic' || (k.t === 'raw' && !k.atom && k.src !== '(?:)')) inner = '(?:' + inner + ')';
      else if (k.t === 'raw' && k.src === '(?:)') inner = '(?:)';
      const q = inner + jxQuantifier(node) ;
      if (node.mode === 'lazy') return q + '?';
      if (node.mode === 'possessive') return '(?=(' + q + '))(?:\\' + node.h + ')';
      return q;
    }
    default: throw new Error('jx: node ' + node.t);
  }
}
function jxTranslate(pattern) {
  const parser = new JxParser(pattern);
  const ast = parser.parseTop();
  const st = { cnt: 0, jmap: [0] };
  jxNumber(ast, st);
  return { src: jxEmit(ast, st), groupCount: parser.ngroups, names: parser.names, jmap: st.jmap, sticky: parser.sticky };
}

const jxCache = new Map();
/* The RegExp of a Java pattern: `whole` = String.matches, flags 'g' for a find loop. Throws { javaMessage }. */
function javaRegex(re, whole, flags) {
  flags = flags || '';
  const key = (whole ? 'w' : 'f') + flags + ':' + re;
  let rx = jxCache.get(key);
  if (rx === undefined) {
    const t = jxTranslate(re);
    try {
      rx = new RegExp(whole ? '^(?:' + t.src + ')$' : t.src, 'u' + flags.replace(/[^g]/g, '') + (t.sticky && !whole ? 'y' : ''));
    } catch (e) {
      throw { javaMessage: 'java.util.regex.PatternSyntaxException: ' + String(e && e.message) + ' near index 0\n' + re };
    }
    rx.jx = t;
    if (jxCache.size >= 256) jxCache.clear();
    jxCache.set(key, rx);
  }
  rx.lastIndex = 0;
  return rx;
}
/* String.replaceAll(regex, replacement): $n, ${name} group references, backslash escapes. */
function javaReplaceAll(s, re, repl) {
  const rx = javaRegex(re, false, 'g');
  const { groupCount, names, jmap } = rx.jx;
  const parts = [];
  const bad = (cls, msg) => { throw { javaMessage: 'java.lang.' + cls + ': ' + msg }; };
  for (let i = 0; i < repl.length; i++) {
    const c = repl.charAt(i);
    if (c === '\\') {
      i++;
      if (i === repl.length) bad('IllegalArgumentException', 'character to be escaped is missing');
      parts.push(repl.charAt(i));
    } else if (c === '$') {
      i++;
      if (i === repl.length) bad('IllegalArgumentException', 'Illegal group reference: group index is missing');
      let ref;
      if (repl.charAt(i) === '{') {
        let j = i + 1;
        while (j < repl.length && (jxIsLetter(repl.charAt(j)) || jxIsDigit(repl.charAt(j)))) j++;
        if (j === i + 1 && repl.charAt(j) === '}') bad('IllegalArgumentException', 'named capturing group has 0 length name');
        if (repl.charAt(j) !== '}') bad('IllegalArgumentException', "named capturing group is missing trailing '}'");
        const name = repl.slice(i + 1, j);
        if (!names.has(name)) bad('IllegalArgumentException', 'No group with name {' + name + '}');
        ref = names.get(name);
        i = j;
      } else {
        const d = repl.charCodeAt(i) - 48;
        if (d < 0 || d > 9) bad('IllegalArgumentException', 'Illegal group reference');
        ref = d;
        if (ref > groupCount) bad('IndexOutOfBoundsException', 'No group ' + ref);
        while (i + 1 < repl.length) {
          const nd = repl.charCodeAt(i + 1) - 48;
          if (nd < 0 || nd > 9) break;
          const nref = ref * 10 + nd;
          if (nref > groupCount) break;
          ref = nref; i++;
        }
      }
      parts.push(ref);
    } else parts.push(c);
  }
  return s.replace(rx, (...m) => parts.map((p) => typeof p === 'number' ? (m[p === 0 ? 0 : jmap[p]] === undefined ? '' : m[p === 0 ? 0 : jmap[p]]) : p).join(''));
}

/* ======================================================================================
 * Pure built-ins (ported from ij.macro.Functions)
 * ==================================================================================== */

/* ---- statements ---- */
function* printFn(f) {
  const it = f.interp;
  it.inPrint = true;
  let s = yield* f.getFirstString();
  if (it.nextToken() === COMMA) {
    if (s.startsWith('[') && s.endsWith(']')) {
      const title = s.substring(1, s.length - 1);
      const s2 = yield* f.getLastString();
      const host = it.ctx.host;
      if (host && typeof host.printToWindow === 'function') yield* f.hostHook(() => host.printToWindow(title, s2));
      else it.error('Window not found');
      return;
    } else if (s === '~0~') {
      if (f.writer === null) it.error('File not open');
      const s2 = yield* f.getLastString();
      const w = f.writer;
      yield* f.hostHook(() => w.print(s2.endsWith('\n') ? s2 : s2 + '\n'));
      it.inPrint = false;
      return;
    }
    let sb = s;
    do {
      sb += ' ' + (yield* f.getNextString());
    } while (it.nextToken() === COMMA);
    s = sb;
  }
  it.getRightParen();
  it.log(s);
  it.inPrint = false;
}
define('do', K_PRINT, printFn, { suspends: printSuspends });
define('do', K_WRITE, printFn, { suspends: printSuspends });
define('do', K_DUMP, (f) => { f.interp.dump(); });

/* ImageJ.VERSION as the host reports it (a host may answer with a Promise: the driver awaits it). */
function* hostVersion(f, host) {
  if (host && typeof host.getVersion === 'function') {
    const v = yield* f.hostHook(() => host.getVersion());
    if (v !== undefined && v !== null) return '' + v;
  }
  return IMAGEJ_VERSION;
}

/* IJ.versionLessThan: a plain String.compareTo against "1.54p". */
define('do', K_REQUIRES, function* (f) {
  const version = yield* f.getStringArg();
  const host = f.interp.ctx.host;
  const current = yield* hostVersion(f, host);
  if (compareTo(current, version) < 0) {
    yield* f.showMessage('ImageJ', 'This plugin or macro requires ImageJ ' + version + ' or later. Use\nHelp>Update ImageJ to upgrade to the latest version.');
    f.interp.done = true;
  }
}, { suspends: true });

define('do', K_EXIT, function* (f) {
  const it = f.interp;
  let msg = null;
  if (it.nextToken() === LP) {
    it.getLeftParen();
    if (it.nextToken() !== RP) msg = yield* f.getString();
    it.getRightParen();
  }
  it.finishUp();
  if (msg !== null) yield* f.showMessage('Macro', msg);
  throw new MacroCancel('exit');
}, { suspends: exitSuspends });

/* ---- math ---- */
/* Math.round(double) widened to a double: NaN -> 0, saturating at Long range, exact for 0.49999999999999994. */
function javaRound(x) {
  if (x !== x) return 0;
  if (x >= 9223372036854775807) return 9223372036854775807;
  if (x <= -9223372036854775808) return -9223372036854775808;
  const r = Math.floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}
function* mathFn(f, type) {
  const arg = yield* f.getArg();
  switch (type) {
    case K_ABS: return Math.abs(arg);
    case K_COS: return Math.cos(arg);
    case K_EXP: return Math.exp(arg);
    case K_FLOOR: return Math.floor(arg);
    case K_LOG: return Math.log(arg);
    case K_ROUND: return Math.floor(arg + 0.5);
    case K_SIN: return Math.sin(arg);
    case K_SQRT: return Math.sqrt(arg);
    case K_TAN: return Math.tan(arg);
    case K_ATAN: return Math.atan(arg);
    case K_ASIN: return Math.asin(arg);
    case K_ACOS: return Math.acos(arg);
    default: return 0.0;
  }
}
for (const id of [K_ABS, K_COS, K_EXP, K_FLOOR, K_LOG, K_ROUND, K_SIN, K_SQRT, K_TAN, K_ATAN, K_ASIN, K_ACOS])
  define('num', id, (f) => mathFn(f, id));

/* Java's Math.pow differs from JS in two corner cases: pow(+-1, +-Infinity) and pow(x, NaN). */
function javaPow(a, b) {
  if (b !== b) return NaN;
  if ((a === 1 || a === -1) && (b === Infinity || b === -Infinity)) return NaN;
  return Math.pow(a, b);
}
const javaMax = (a, b) => (a !== a || b !== b) ? NaN : (a === 0 && b === 0) ? (Object.is(a, -0) ? b : a) : Math.max(a, b);
const javaMin = (a, b) => (a !== a || b !== b) ? NaN : (a === 0 && b === 0) ? (Object.is(a, -0) ? a : b) : Math.min(a, b);
function* math2Fn(f, type) {
  const a1 = yield* f.getFirstArg();
  const a2 = yield* f.getLastArg();
  switch (type) {
    case K_MIN_OF: return javaMin(a1, a2);
    case K_MAX_OF: return javaMax(a1, a2);
    case K_POW: return javaPow(a1, a2);
    case K_ATAN2: return Math.atan2(a1, a2);
    default: return 0.0;
  }
}
for (const id of [K_MAX_OF, K_MIN_OF, K_POW, K_ATAN2]) define('num', id, (f) => math2Fn(f, id));

/* Math.* namespace (Functions.doMath) */
define('num', K_MATH, function* (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  if (name === 'min') return javaMin(yield* f.getFirstArg(), yield* f.getLastArg());
  if (name === 'max') return javaMax(yield* f.getFirstArg(), yield* f.getLastArg());
  if (name === 'pow') return javaPow(yield* f.getFirstArg(), yield* f.getLastArg());
  if (name === 'atan2') return Math.atan2(yield* f.getFirstArg(), yield* f.getLastArg());
  if (name === 'constrain') {
    const a = yield* f.getFirstArg(), b = yield* f.getNextArg(), c = yield* f.getLastArg();
    return javaMin(javaMax(a, b), c);
  }
  if (name === 'map') {
    const value = yield* f.getFirstArg();
    const fromLow = yield* f.getNextArg();
    const fromHigh = yield* f.getNextArg();
    const toLow = yield* f.getNextArg();
    const toHigh = yield* f.getLastArg();
    return (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow) + toLow;
  }
  const arg = yield* f.getArg();
  switch (name) {
    case 'ceil': return Math.ceil(arg);
    case 'abs': return Math.abs(arg);
    case 'cos': return Math.cos(arg);
    case 'exp': return Math.exp(arg);
    case 'floor': return Math.floor(arg);
    case 'log': return Math.log(arg);
    case 'log10': return log10Java(arg);
    case 'round': return javaRound(arg);
    case 'sin': return Math.sin(arg);
    case 'sqr': return arg * arg;
    case 'sqrt': return Math.sqrt(arg);
    case 'tan': return Math.tan(arg);
    case 'atan': return Math.atan(arg);
    case 'asin': return Math.asin(arg);
    case 'acos': return Math.acos(arg);
    case 'erf': return erf(arg);
    case 'toRadians': return arg * 0.017453292519943295;
    case 'toDegrees': return arg * 57.29577951308232;
    default:
      it.error('Unrecognized function name');
      return NaN;
  }
});
/* ij.util.IJMath.erf: rational approximation of the Gauss error function, then r = sqrt(1 - exp(-t^2)). */
function erf(x) {
  const x2 = x * x;
  let r;
  if (x2 < 1e-8) r = Math.abs(2 / Math.sqrt(Math.PI) * x * (1 + x2 * (-1 / 3 + x2 * 0.1)));
  else if (x2 > 36) r = 1;
  else {
    const A = 0.05857895078654251, B = -0.006262458957728196, C = -0.002999464506960368, D = 0.2893896964960824,
      E = 0.053996258985163297, F = 0.005085169099306531, G = 2.1596971304614287E-4, H = -2.2566385834049156E-4,
      I = -3.0683321347252904E-7;
    const t = x * (2 / Math.sqrt(Math.PI) - A + A * (1 + x2 * x2 * (B + x2 * (C + x2 * (H + x2 * I)))) /
      (1 + x2 * (D + x2 * (E + x2 * (F + x2 * G)))));
    r = Math.sqrt(1 - Math.exp(-t * t));
  }
  return x > 0 ? r : -r;
}
function log10Java(x) { return x > 0 && x !== Infinity ? log10(x) : Math.log10(x); }

/* ---- numbers and strings ---- */
define('num', K_IS_NAN, function* (f) { const v = yield* f.getArg(); return v !== v ? 1 : 0; });
define('num', K_GET_TIME, (f) => { f.interp.getParens(); return Date.now(); });

function parseDoubleFn(s) {
  if (s === null) return 0.0;
  s = javaTrim(s);
  if (s.indexOf(' ') !== -1) s = s.substring(0, s.indexOf(' '));
  return toolsParseDouble(s, NaN);
}
define('num', K_PARSE_FLOAT, function* (f) { return parseDoubleFn(yield* f.getStringArg()); });
define('num', K_PARSE_INT, function* (f) {
  const it = f.interp;
  const s = yield* f.getFirstString();
  let radix = 10;
  if (it.nextToken() === COMMA) {
    it.getComma();
    radix = toInt(yield* it.getExpression());
    if (radix < 2 || radix > 36) radix = 10;
  }
  it.getRightParen();
  let n;
  if (radix === 10) {
    n = parseDoubleFn(s);
    if (n === n) n = javaRound(n);
  } else {
    // Integer.parseInt(s, radix): optional sign, digits of the radix, fits an int
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
    const m = /^([+-]?)(.+)$/.exec(s);
    n = NaN;
    if (m && [...m[2].toLowerCase()].every((c) => digits.indexOf(c) >= 0)) {
      let v = 0n;
      for (const c of m[2].toLowerCase()) v = v * BigInt(radix) + BigInt(digits.indexOf(c));
      if (m[1] === '-') v = -v;
      if (v >= -2147483648n && v <= 2147483647n) n = Number(v);
    }
  }
  return n;
});

define('num', K_LENGTH_OF, function* (f) {
  const it = f.interp, code = f.pgm.code;
  let length = 0;
  it.getLeftParen();
  switch (it.nextToken()) {
    case STRING_CONSTANT: case STRING_FUNCTION: case USER_FUNCTION:
      length = (yield* f.getString()).length;
      break;
    case WORD: {
      if (code[it.pc + 2] === LSQ) { length = (yield* f.getString()).length; break; }
      it.getToken();
      const v = it.lookupVariable();
      if (v === null) return 0.0;
      const s = v.getString();
      if (s !== null) length = s.length;
      else {
        const array = v.getArray();
        if (array !== null) length = v.getArraySize();
        else it.error('String or array expected');
      }
      break;
    }
    default:
      it.error('String or array expected');
  }
  it.getRightParen();
  return length;
});

define('num', K_INDEX_OF, (f) => f.indexOf(null));
define('num', K_LAST_INDEX_OF, function* (f) { return (yield* f.getFirstString()).lastIndexOf(yield* f.getLastString()); });
define('num', K_STARTS_WITH, function* (f) { const a = yield* f.getFirstString(); return a.startsWith(yield* f.getLastString()) ? 1 : 0; });
define('num', K_ENDS_WITH, function* (f) { const a = yield* f.getFirstString(); return a.endsWith(yield* f.getLastString()) ? 1 : 0; });
define('num', K_MATCHES, (f) => f.matches(null));
define('num', K_CHAR_CODE_AT, function* (f) {
  const str = yield* f.getFirstString();
  const index = toInt(yield* f.getLastArg());
  f.checkIndex(index, 0, str.length - 1);
  return str.charCodeAt(index);
});

define('str', K_D2S, function* (f) {
  const x = yield* f.getFirstArg();
  return d2s(x, toInt(yield* f.getLastArg()));
});
define('str', K_TO_HEX, function* (f) { return (toInt(yield* f.getArg()) >>> 0).toString(16); });
define('str', K_TO_BINARY, function* (f) { return (toInt(yield* f.getArg()) >>> 0).toString(2); });
define('str', K_SUBSTRING, (f) => f.substring(null));
define('str', K_REPLACE, (f) => f.replace(null));
define('str', K_TO_LOWER_CASE, function* (f) { return (yield* f.getStringArg()).toLowerCase(); });
define('str', K_TO_UPPER_CASE, function* (f) { return (yield* f.getStringArg()).toUpperCase(); });
define('str', K_TRIM, function* (f) {
  if (f.interp.nextToken() === EQUALS) f.interp.error("'trim' is a reserved word");
  return javaTrim(yield* f.getStringArg());
});
define('str', K_FROM_CHAR_CODE, function* (f) {
  const it = f.interp;
  let s = '', count = 0;
  it.getLeftParen();
  while (it.nextToken() !== RP) {
    const value = toInt(yield* it.getExpression());
    if (value < 0 || value > 65535) it.error('Value (' + value + ') out of 0-65535 range');
    if (count === 100) throw new JavaException('java.lang.ArrayIndexOutOfBoundsException: Index 100 out of bounds for length 100');   // Functions.fromCharCode: char[100]
    count++;
    s += String.fromCharCode(value);
    if (it.nextToken() === COMMA) it.getToken();
  }
  it.getRightParen();
  return s;
});
define('str', K_TO_STRING, function* (f) {
  const it = f.interp;
  it.getLeftParen();
  if (it.nextNextToken() === COMMA) {   // toString(number, decimalPlaces)
    const n = yield* it.getExpression();
    const digits = toInt(yield* f.getLastArg());
    return d2s(n, digits);
  }
  let s = yield* f.getString();
  it.getToken();
  if (it.token === COMMA) {
    const value = toolsParseDouble(s, NaN);
    s = d2s(value, toInt(yield* it.getExpression()));
    it.getToken();
  }
  if (it.token !== RP) it.error("')' expected");
  return s;
});
define('str', K_GET_ARGUMENT, (f) => { f.interp.getParens(); return f.interp.argument !== null ? f.interp.argument : ''; });
define('str', K_GET_VERSION, function* (f) {
  f.interp.getParens();
  return yield* hostVersion(f, f.interp.ctx.host);
}, { suspends: 'host' });

/* ---- arrays ---- */
define('arr', K_NEW_ARRAY, function* (f) {
  const it = f.interp;
  if (it.nextToken() !== LP || it.nextNextToken() === RP) {
    it.getParens();
    return [];
  }
  it.getLeftParen();
  const vector = [];
  do {
    const v = new Variable();
    if (f.isStringArg()) v.setString(yield* f.getString());
    else v.setValue(yield* it.getExpression());
    vector.push(v);
    it.getToken();
  } while (it.token === COMMA);
  if (it.token !== RP) it.error("';' expected");
  if (vector.length === 1 && vector[0].getString() === null) {
    const size = toInt(vector[0].getValue());
    if (size < 0) it.error('Negative array size');
    checkArraySize(it, size);
    const array2 = new Array(size);
    for (let i = 0; i < size; i++) array2[i] = new Variable();
    return array2;
  }
  return vector;
});

/* ---- eval() / runMacro(): a nested interpreter, as IJ.runMacro does ---- */
function* runNestedMacro(f, code, arg) {
  const outer = f.interp;
  const nested = new Interpreter(outer.ctx);
  nested.argument = arg;
  nested.calledMacro = true;
  try {
    yield* nested.run(code);
    return nested.returnValue;
  } catch (e) {
    if (e instanceof MacroCancel && e.kind === 'abort') throw e;
    if (isInternalFault(e)) throw e;
    if (e instanceof MacroCancel && e.kind === 'error' && nested.wasError && !nested.errorSilent)
      yield* f.hostHook(() => outer.ctx.showError(nested.errorDialogText()));
    return '[aborted]';   // Macro_Runner.runMacro: a canceled or failed macro
  }
}
define('str', K_EVAL, function* (f) {
  const it = f.interp;
  it.getLeftParen();
  const name = yield* f.getString();
  let arg = null;
  if (it.nextToken() === COMMA) { it.getComma(); arg = yield* f.getString(); }
  it.getRightParen();
  if (arg !== null && (name === 'script' || name === 'js')) {
    yield* f.showMessage('Macro', 'Could not find JavaScript engine');
    return '';
  }
  if (arg !== null && (name === 'bsh' || name === 'python')) return f.notAvailable(K_EVAL, 'str');
  return yield* runNestedMacro(f, name, arg);
}, { suspends: true });
define('str', K_RUN_MACRO, function* (f) {
  const it = f.interp;
  it.getLeftParen();
  const name = yield* f.getString();
  let arg = null;
  if (it.nextToken() === COMMA) { it.getComma(); arg = yield* f.getString(); }
  it.getRightParen();
  const host = it.ctx.host;
  if (host && typeof host.runMacroFile === 'function') {
    const src = yield* f.hostHook(() => host.runMacroFile(name, arg));
    if (src === null || src === undefined) return null;
    return yield* runNestedMacro(f, String(src), arg);
  }
  yield* f.showMessage('Macro Runner', 'Macro or script not found:\n \n' + name);
  return null;
}, { suspends: true });

/* ======================================================================================
 * Pure built-ins, part 2: random, split, List.*, String.*, IJ.*, Array.* (ij.macro.Functions)
 * ==================================================================================== */

/* A java.lang exception as the macro sees it: interp.error(""+e) prints Class: message. */
class JavaEx {
  constructor(cls, message) { this.cls = cls; this.msg = message === undefined ? null : message; }
  toString() { return this.msg === null ? this.cls : this.cls + ': ' + this.msg; }
}
function errText(e) {
  if (e instanceof JavaEx) return e.toString();
  if (e && e.javaMessage) return e.javaMessage;
  return String(e && e.message !== undefined ? e.message : e);
}

/* Double.compare: -0.0 < 0.0, NaN above everything and equal to itself. */
function javaDoubleCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) {
    if (a === 0) { const na = Object.is(a, -0), nb = Object.is(b, -0); return na === nb ? 0 : na ? -1 : 1; }
    return 0;
  }
  const an = a !== a, bn = b !== b;
  return an === bn ? 0 : an ? 1 : -1;
}

/* ---- java.util.Random (48-bit LCG, split in two 24-bit halves so the products stay exact doubles) ---- */
const JR_M_HI = 0x5DE, JR_M_LO = 0xECE66D, JR_ADD = 0xB, JR_2P24 = 16777216, JR_2P27 = 134217728;
class JavaRandom {
  constructor(seed) {
    if (seed === undefined) seed = BigInt(Math.floor(Math.random() * 9007199254740991)) ^ BigInt(Date.now());
    this.setSeed(seed);
  }
  setSeed(seed) {
    const st = (BigInt.asUintN(64, seed) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
    this.hi = Number(st >> 24n);
    this.lo = Number(st & 0xFFFFFFn);
    this.haveNext = false;
    this.nextNext = 0;
  }
  next(bits) {
    const lo = this.lo, hi = this.hi;
    const p = lo * JR_M_LO + JR_ADD;
    const carry = Math.floor(p / JR_2P24);
    const nlo = p - carry * JR_2P24;
    const q = hi * JR_M_LO + lo * JR_M_HI + carry;
    const nhi = q - Math.floor(q / JR_2P24) * JR_2P24;
    this.lo = nlo; this.hi = nhi;
    return Math.floor((nhi * JR_2P24 + nlo) / Math.pow(2, 48 - bits)) | 0;
  }
  nextDouble() { const a = this.next(26); return (a * JR_2P27 + this.next(27)) / 9007199254740992; }
  nextGaussian() {
    if (this.haveNext) { this.haveNext = false; return this.nextNext; }
    let v1, v2, s;
    do {
      v1 = 2 * this.nextDouble() - 1;
      v2 = 2 * this.nextDouble() - 1;
      s = v1 * v1 + v2 * v2;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);   // StrictMath.log is fdlibm, as V8's
    this.nextNext = v2 * mul; this.haveNext = true;
    return v1 * mul;
  }
}

/* Functions.random(): random, random("seed", n), random("gaussian"). The seed also reseeds ImageProcessor's
 * noise generator (ctx.imageRandomSeed, NaN = unseeded) for the image built-ins that draw random numbers. */
define('num', K_RANDOM, function* (f) {
  const it = f.interp;
  let dseed = NaN, gaussian = false;
  if (it.nextToken() === LP) {
    it.getLeftParen();
    if (f.isStringArg()) {
      const arg = (yield* f.getString()).toLowerCase();
      if (arg === 'seed') {
        it.getComma();
        dseed = yield* it.getExpression();
        let seed;
        if (dseed !== dseed) seed = 0n;
        else if (dseed >= 9223372036854775807) seed = 9223372036854775807n;
        else if (dseed <= -9223372036854775808) seed = -9223372036854775808n;
        else seed = BigInt(Math.trunc(dseed));
        if (Number(seed) !== dseed) it.error('Seed not integer');
        f.ran = new JavaRandom(seed);
        it.ctx.imageRandomSeed = Number(seed);
      } else if (arg === 'gaussian') gaussian = true;
      else it.error("'seed' or ''gaussian' expected");
    }
    it.getRightParen();
    if (dseed === dseed) return NaN;
  }
  it.ctx.imageRandomSeed = NaN;
  it.getParens();
  if (f.ran === null || f.ran === undefined) f.ran = new JavaRandom();
  return gaussian ? f.ran.nextGaussian() : f.ran.nextDouble();
});

/* ---- split ---- */
/* java.util.regex.Matcher.find loop: every non-overlapping match, an empty match advancing by one. */
function javaFindAll(rx, s) {
  const out = [];
  rx.lastIndex = 0;
  for (;;) {
    const m = rx.exec(s);
    if (m === null) break;
    out.push(m);
    if (m[0].length === 0) rx.lastIndex++;
    if (rx.lastIndex > s.length) break;
  }
  return out;
}
/* String.split(regex, limit) with a negative limit: trailing empty strings kept; a zero-width match at
 * index 0 never produces a leading empty string. */
function javaSplit(s, re) {
  const rx = javaRegex(re, false, 'g');
  const list = [];
  let index = 0;
  for (const m of javaFindAll(rx, s)) {
    const end = m.index + m[0].length;
    if (index === 0 && m.index === 0 && end === 0) continue;
    list.push(s.substring(index, m.index));
    index = end;
  }
  if (index === 0 && list.length === 0) return [s];
  list.push(s.substring(index));
  return list;
}
/* java.util.StringTokenizer(str, delims): the runs of non-delimiter characters. */
function stringTokens(str, delims) {
  const out = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    while (i < n && delims.indexOf(str.charAt(i)) >= 0) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && delims.indexOf(str.charAt(i)) < 0) i++;
    out.push(str.substring(start, i));
  }
  return out;
}
/* BufferedReader.readLine over the string: \n, \r and \r\n end a line; no empty last line. */
function splitLines(str) {
  const out = [];
  let start = 0;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    const c = str.charCodeAt(i);
    if (c === 10 || c === 13) {
      out.push(str.substring(start, i));
      if (c === 13 && i + 1 < n && str.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < n) out.push(str.substring(start));
  return out;
}
/* ij.util.Tools.split(str, delim) */
function toolsSplit(str, delim) {
  if (delim === undefined) delim = ' \t\n\r';
  if (delim === '\n') return splitLines(str);
  const t = stringTokens(str, delim);
  return t;   // Tools.split: countTokens() > 0 ? tokens : new String[0]
}
define('arr', K_SPLIT, function* (f) {
  const it = f.interp;
  const s1 = yield* f.getFirstString();
  let s2 = null;
  if (it.nextToken() === RP) it.getRightParen();
  else s2 = yield* f.getLastString();
  let strings;
  try {
    if (s1.length > 0 && s2 !== null && (s2 === ',' || s2 === ';')) strings = javaSplit(s1, s2);
    else if (s1.length > 0 && s2 !== null && s2.length >= 3 && s2.startsWith('(') && s2.endsWith(')'))
      strings = javaSplit(s1, s2.substring(1, s2.length - 1));
    else strings = (s2 === null || s2 === '') ? toolsSplit(s1) : toolsSplit(s1, s2);
  } catch (e) {
    if (isInternalFault(e)) throw e;
    it.error(errText(e));
    return [];
  }
  return strings.map((x) => Variable.string(x));
});

/* ---- Array helpers shared with ImageJ's Tools / IJ ---- */
/* ij.util.Tools.rank: the indexes that sort the values (stable). */
function rankNumbers(values) {
  const idx = values.map((_, i) => i);
  idx.sort((a, b) => javaDoubleCompare(values[a], values[b]));
  return idx;
}
function rankStrings(values) {
  const idx = values.map((_, i) => i);
  idx.sort((a, b) => compareToIgnoreCase(values[a], values[b]));
  return idx;
}
/* ResultsTable.d2s(v, n): NaN, +-Infinity as words, and a non-zero number that would print as all zeros in
 * scientific notation with one decimal fewer (1e-5 -> 1.000E-5). */
function resultsTableD2s(n, decimalPlaces) {
  if (n !== n) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (n === 3.4028234663852886e38) return '3.4e38';
  const s = d2s(n, decimalPlaces);
  if (n !== 0 && /^-?0\.0+$/.test(s)) return d2s(n, -(decimalPlaces - 1));
  return s;
}
/* Functions.joinArray: IJ.d2s(v, 0) for whole numbers, ResultsTable.d2s(v, 4) otherwise. */
function joinArray(a, delimiter) {
  const parts = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = a[i].getString();
    if (s === null) {
      const v = a[i].getValue();
      s = toInt(v) === v ? d2s(v, 0) : resultsTableD2s(v, 4);
    }
    parts[i] = s;
  }
  return parts.join(delimiter);
}
function duplicate(a) { return a.map((v) => v.clone()); }

/* A macro that asks for a string or array no browser tab can hold gets a macro error (ImageJ: a catchable OutOfMemoryError). */
const MAX_STRING_CHARS = 1 << 27, MAX_ARRAY_ELEMENTS = 1 << 24;
function checkStringSize(it, n) { if (n > MAX_STRING_CHARS) it.error('Out of memory'); }
function checkArraySize(it, n) { if (n > MAX_ARRAY_ELEMENTS) it.error('Out of memory'); }

/* IJ.pad */
function ijPad(s, digits) {
  while (s.length < digits) s = '0' + s;
  return s;
}
function* padFn(f) {
  const it = f.interp;
  let stringArg = null, intArg = 0;
  it.getLeftParen();
  if (f.isStringArg()) stringArg = yield* f.getString();
  else intArg = toInt(yield* it.getExpression());
  const digits = toInt(yield* f.getLastArg());
  checkStringSize(it, digits);
  return stringArg !== null ? ijPad(stringArg, digits) : ijPad('' + intArg, digits);
}

/* ---- MaximumFinder.findMaxima / findMinima (1D, ij.plugin.filter.MaximumFinder) ---- */
function findMaxima1D(xx, tolerance, edgeMode) {
  const len = xx.length;
  if (len === 0) return [];
  if (tolerance < 0) tolerance = 0;
  const maxPositions = new Array(len).fill(0);
  let max = xx[0], min = xx[0], maxPos = 0, lastMaxPos = -1, maxCount = 0;
  let leftValleyFound = edgeMode === 2;
  for (let jj = 1; jj < len; jj++) {
    const val = xx[jj];
    if (val > min + tolerance) leftValleyFound = true;
    if (val > max && leftValleyFound) { max = val; maxPos = jj; }
    if (leftValleyFound) lastMaxPos = maxPos;
    if (val < max - tolerance && leftValleyFound) {
      maxPositions[maxCount++] = maxPos;
      leftValleyFound = false;
      min = val; max = val;
    }
    if (val < min) { min = val; if (!leftValleyFound) max = val; }
  }
  if (edgeMode === 1) {
    if (maxCount > 0 && maxPositions[maxCount - 1] !== lastMaxPos) maxPositions[maxCount++] = lastMaxPos;
    if (maxCount === 0 && max - min >= tolerance) maxPositions[maxCount++] = lastMaxPos;
  }
  const pos = maxPositions.slice(0, maxCount);
  const maxValues = new Array(maxCount);
  for (let jj = 0; jj < maxCount; jj++) {
    let p = pos[jj], midPos = p;
    while (p < len - 1 && xx[p] === xx[p + 1]) { midPos += 0.5; p++; }
    pos[jj] = toInt(midPos);
    maxValues[jj] = xx[pos[jj]];
  }
  const rank = rankNumbers(maxValues);
  const ret = new Array(maxCount);
  for (let jj = 0; jj < maxCount; jj++) ret[maxCount - jj - 1] = pos[rank[jj]];
  return ret;
}

/* ---- Array.fourier: only what is verified against the oracle ----
 * FHT.fourier1D pads to a power of two and applies an optional window; only an array whose length is
 * already a power of two, with the "none" window, is reproduced (amplitudes sqrt(H[k]^2 + H[N-k]^2) / N =
 * sqrt(2) |X[k]| / N, DC |X[0]| / N, size/2 values). Anything else reports "not available". */
function fourierAmplitudes(data) {
  const n = data.length;
  const re = Float64Array.from(data), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {   // iterative radix-2 FFT: bit reversal, then butterflies
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = -2 * Math.PI / len;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k), wi = Math.sin(step * k);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const tr = re[j] * wr - im[j] * wi, ti = re[j] * wi + im[j] * wr;
        re[j] = re[i] - tr; im[j] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
    }
  }
  const out = new Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n;
    out[k] = Math.fround(k === 0 ? mag : mag * Math.SQRT2);
  }
  return out;
}

/* ---- Java String.format for Double arguments (java.util.Formatter) ---- */
function groupDigits(intPart) {
  let out = '';
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) out += ',';
    out += intPart.charAt(i);
  }
  return out;
}
/* N = value x 10^prec as a digit string, rounded HALF_UP on the shortest digits (FormattedFloatingDecimal). */
function scaledDigits(a, prec) {
  if (a === 0) return '0';
  const sd = shortestDigits(a);
  const keep = sd.exp + 1 + prec;
  if (keep < 0) return '0';
  if (keep >= sd.digits.length) return sd.digits + '0'.repeat(keep - sd.digits.length);
  const head = sd.digits.slice(0, keep);
  if (sd.digits.charCodeAt(keep) < 53) return head === '' ? '0' : head;
  return head === '' ? '1' : (BigInt(head) + 1n).toString();
}
function fixedString(a, prec, grouping) {
  let N = scaledDigits(a, prec);
  if (N.length <= prec) N = '0'.repeat(prec - N.length + 1) + N;
  const ip = N.slice(0, N.length - prec);
  return (grouping ? groupDigits(ip) : ip) + (prec > 0 ? '.' + N.slice(N.length - prec) : '');
}
function sciParts(a, prec) {
  if (a === 0) return { mant: prec > 0 ? '0.' + '0'.repeat(prec) : '0', e10: 0 };
  const sd = shortestDigits(a);
  const keep = prec + 1;
  let d;
  if (keep >= sd.digits.length) d = sd.digits + '0'.repeat(keep - sd.digits.length);
  else {
    d = sd.digits.slice(0, keep);
    if (sd.digits.charCodeAt(keep) >= 53) d = (BigInt(d) + 1n).toString();
  }
  let e10 = sd.exp;
  if (d.length > keep) { d = d.slice(0, keep); e10++; }
  return { mant: d.charAt(0) + (prec > 0 ? '.' + d.slice(1) : ''), e10 };
}
function expString(e10) {
  const ae = Math.abs(e10);
  return 'e' + (e10 < 0 ? '-' : '+') + (ae < 10 ? '0' : '') + ae;
}
function javaFormat(fmt, params) {
  let out = '', i = 0, ordinary = 0, last = -1;
  const n = fmt.length;
  while (i < n) {
    const c = fmt.charAt(i);
    if (c !== '%') { out += c; i++; continue; }
    const m = /^%(\d+\$)?([-#+ 0,(<]*)(\d+)?(\.\d+)?([tT])?([a-zA-Z%])/.exec(fmt.slice(i));
    if (m === null) throw new JavaEx('java.util.UnknownFormatConversionException', "Conversion = '" + (i + 1 < n ? fmt.charAt(i + 1) : '%') + "'");
    const spec = m[0];
    i += spec.length;
    const flags = m[2];
    const width = m[3] !== undefined ? parseInt(m[3], 10) : -1;
    const prec = m[4] !== undefined ? parseInt(m[4].slice(1), 10) : -1;
    const conv = m[6];
    if (width > MAX_STRING_CHARS) throw new JavaEx('java.lang.OutOfMemoryError', 'Java heap space');
    if (m[5] !== undefined) throw new JavaEx('java.util.IllegalFormatConversionException', m[5] + ' != java.lang.Double');
    const left = flags.indexOf('-') >= 0, plus = flags.indexOf('+') >= 0, space = flags.indexOf(' ') >= 0;
    const zero = flags.indexOf('0') >= 0, comma = flags.indexOf(',') >= 0, paren = flags.indexOf('(') >= 0, alt = flags.indexOf('#') >= 0;
    if (conv === 'n') { out += '\n'; continue; }
    if (conv === '%') {
      if (prec >= 0) throw new JavaEx('java.util.IllegalFormatPrecisionException', '' + prec);
      let s = '%';
      if (width > 1) s = left ? s + ' '.repeat(width - 1) : ' '.repeat(width - 1) + s;
      out += s; continue;
    }
    if ((left || zero) && width < 0) throw new JavaEx('java.util.MissingFormatWidthException', spec);
    if ((left && zero) || (plus && space)) throw new JavaEx('java.util.IllegalFormatFlagsException', "Flags = '" + flags + "'");
    let idx;
    if (flags.indexOf('<') >= 0) idx = last;
    else if (m[1] !== undefined) idx = parseInt(m[1], 10) - 1;
    else idx = ordinary++;
    if (idx < 0 || idx >= params.length) throw new JavaEx('java.util.MissingFormatArgumentException', "Format specifier '" + spec + "'");
    last = idx;
    const arg = params[idx];
    const lc = conv.toLowerCase(), upper = conv !== lc;
    let body;
    if (lc === 'f' || lc === 'e' || lc === 'g') {
      if (alt && lc === 'g') throw new JavaEx('java.util.FormatFlagsConversionMismatchException', 'Conversion = ' + conv + ', Flags = #');
      if (comma && lc === 'e') throw new JavaEx('java.util.FormatFlagsConversionMismatchException', 'Conversion = ' + conv + ', Flags = ,');
      const neg = arg < 0 || Object.is(arg, -0);
      if (arg !== arg) body = 'NaN';
      else if (arg === Infinity || arg === -Infinity)
        body = (neg ? (paren ? '(' : '-') : plus ? '+' : space ? ' ' : '') + 'Infinity' + (neg && paren ? ')' : '');
      else {
        const a = Math.abs(arg);
        const p = prec < 0 ? 6 : prec;
        let mag;
        if (lc === 'f') mag = fixedString(a, p, comma) + (alt && p === 0 ? '.' : '');
        else if (lc === 'e') { const s = sciParts(a, p); mag = s.mant + (alt && p === 0 ? '.' : '') + expString(s.e10); }
        else {
          const gp = prec < 0 ? 6 : prec === 0 ? 1 : prec;
          if (a === 0) mag = fixedString(0, gp - 1, comma);
          else {
            const s = sciParts(a, gp - 1);
            if (s.e10 < -4 || s.e10 >= gp) mag = s.mant + expString(s.e10);
            else mag = fixedString(a, gp - 1 - s.e10, comma);
          }
        }
        const prefix = neg ? (paren ? '(' : '-') : plus ? '+' : space ? ' ' : '';
        const suffix = neg && paren ? ')' : '';
        if (zero && width > 0) {
          const fill = width - prefix.length - mag.length - suffix.length;
          if (fill > 0) mag = '0'.repeat(fill) + mag;
        }
        body = prefix + mag + suffix;
      }
    } else if (lc === 's') {
      if (alt) throw new JavaEx('java.util.FormatFlagsConversionMismatchException', 'Conversion = ' + conv + ', Flags = #');
      body = javaDouble(arg);
      if (prec >= 0) body = body.substring(0, prec);
    } else if (lc === 'b') {
      body = 'true';
      if (prec >= 0) body = body.substring(0, prec);
    } else if (lc === 'h') {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, arg);
      body = ((dv.getUint32(0) ^ dv.getUint32(4)) >>> 0).toString(16);
      if (prec >= 0) body = body.substring(0, prec);
    } else if ('cdoxXtT'.indexOf(conv) >= 0)
      throw new JavaEx('java.util.IllegalFormatConversionException', conv + ' != java.lang.Double');
    else if (lc === 'a')
      throw new JavaEx('java.lang.UnsupportedOperationException', 'hexadecimal floating point (%a) is not available in the browser');
    else throw new JavaEx('java.util.UnknownFormatConversionException', "Conversion = '" + conv + "'");
    if (upper) body = body.toUpperCase();
    if (width > body.length) body = left ? body + ' '.repeat(width - body.length) : ' '.repeat(width - body.length) + body;
    out += body;
  }
  return out;
}

/* ---- MD5 / SHA-256 of a string's bytes (IJ.checksum) ---- */
function utf8Bytes(s) {
  const b = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    } else if (c >= 0xd800 && c < 0xe000) c = 63;   // lone surrogate -> '?'
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return b;
}
const hex2 = (bytes) => bytes.map((x) => (x & 255).toString(16).padStart(2, '0')).join('');
function md5(bytes) {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const T = [];
  for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const len = bytes.length;
  const m = bytes.slice();
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  const lo = (len * 8) >>> 0, hi = Math.floor(len / 536870912) >>> 0;
  for (let i = 0; i < 4; i++) m.push((lo >>> (8 * i)) & 255);
  for (let i = 0; i < 4; i++) m.push((hi >>> (8 * i)) & 255);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < m.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M[i] = (m[off + 4 * i] | (m[off + 4 * i + 1] << 8) | (m[off + 4 * i + 2] << 16) | (m[off + 4 * i + 3] << 24)) >>> 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + T[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = [];
  for (const w of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) out.push((w >>> (8 * i)) & 255);
  return out;
}
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256(bytes) {
  const len = bytes.length;
  const m = bytes.slice();
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  for (const w of [Math.floor(len / 536870912) >>> 0, (len * 8) >>> 0]) for (let i = 3; i >= 0; i--) m.push((w >>> (8 * i)) & 255);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = ((m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3]) | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + W[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = [];
  for (const w of H) for (let i = 3; i >= 0; i--) out.push((w >>> (8 * i)) & 255);
  return out;
}

/* ---- java.util.Properties (List.*) ---- */
/* Properties.load(InputStream): the text is encoded to UTF-8 bytes and read back as ISO-8859-1, as
 * Functions.setPropertiesFromString does; returns a Map. */
function loadProperties(text) {
  const s = utf8Bytes(text).map((b) => String.fromCharCode(b)).join('');
  const props = new Map();
  const n = s.length;
  let pos = 0;
  const WS = (c) => c === ' ' || c === '\t' || c === '\f';
  /* Properties.LineReader.readLine: one logical line (continuations joined, comments and blanks skipped). */
  const readLine = () => {
    let buf = '', skipWhiteSpace = true, isCommentLine = false, isNewLine = true, appendedLineBegin = false, precedingBackslash = false, skipLF = false;
    for (;;) {
      if (pos >= n) {
        if (isCommentLine || buf.length === 0) return null;
        if (precedingBackslash) buf = buf.slice(0, -1);
        return buf;
      }
      const c = s.charAt(pos++);
      if (skipLF) { skipLF = false; if (c === '\n') continue; }
      if (skipWhiteSpace) {
        if (WS(c)) continue;
        if (!appendedLineBegin && (c === '\r' || c === '\n')) continue;
        skipWhiteSpace = false; appendedLineBegin = false;
      }
      if (isNewLine) {
        isNewLine = false;
        if (c === '#' || c === '!') { isCommentLine = true; continue; }
      }
      if (c !== '\n' && c !== '\r') {
        buf += c;
        precedingBackslash = c === '\\' ? !precedingBackslash : false;
      } else {
        if (isCommentLine || buf.length === 0) { isCommentLine = false; isNewLine = true; skipWhiteSpace = true; buf = ''; if (c === '\r') skipLF = true; continue; }
        if (pos >= n) { if (precedingBackslash) buf = buf.slice(0, -1); return buf; }
        if (precedingBackslash) {
          buf = buf.slice(0, -1);
          skipWhiteSpace = true; appendedLineBegin = true; precedingBackslash = false;
          if (c === '\r') skipLF = true;
        } else {
          if (c === '\r' && pos < n && s.charAt(pos) === '\n') pos++;
          return buf;
        }
      }
    }
  };
  const convert = (str) => {
    let o = '';
    for (let i = 0; i < str.length;) {
      let c = str.charAt(i++);
      if (c === '\\') {
        c = str.charAt(i++);
        if (c === 'u') {
          let v = 0;
          for (let k = 0; k < 4; k++) {
            const h = str.charAt(i++);
            if (!/^[0-9a-fA-F]$/.test(h)) throw new JavaEx('java.lang.IllegalArgumentException', 'Malformed \\uxxxx encoding.');
            v = (v << 4) + parseInt(h, 16);
          }
          o += String.fromCharCode(v);
        } else o += c === 't' ? '\t' : c === 'r' ? '\r' : c === 'n' ? '\n' : c === 'f' ? '\f' : c;
      } else o += c;
    }
    return o;
  };
  for (;;) {
    const line = readLine();
    if (line === null) break;
    const limit = line.length;
    let keyLen = 0, valueStart = limit, hasSep = false, bs = false;
    while (keyLen < limit) {
      const c = line.charAt(keyLen);
      if ((c === '=' || c === ':') && !bs) { valueStart = keyLen + 1; hasSep = true; break; }
      if (WS(c) && !bs) { valueStart = keyLen + 1; break; }
      bs = c === '\\' ? !bs : false;
      keyLen++;
    }
    while (valueStart < limit) {
      const c = line.charAt(valueStart);
      if (!WS(c)) {
        if (!hasSep && (c === '=' || c === ':')) hasSep = true; else break;
      }
      valueStart++;
    }
    props.set(convert(line.substring(0, keyLen)), convert(line.substring(valueStart)));
  }
  return props;
}
const sortedKeys = (props) => [...props.keys()].sort(compareTo);

define('str', K_LIST, function* (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === ARRAY_FUNCTION || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  if (f.props === null) f.props = new Map();
  const props = f.props;
  let value = null;
  const name = it.tokenString;
  if (name === 'get') {
    const v = props.get(yield* f.getStringArg());
    value = v !== undefined ? v : '';
  } else if (name === 'getValue') {
    const v = props.get(yield* f.getStringArg());
    if (v === undefined) it.error('Value not found');
    value = v === undefined ? null : v;
  } else if (name === 'set' || name === 'add' || name === 'put') {
    const key = yield* f.getFirstString();
    props.set(key, yield* f.getLastString());
  } else if (name === 'clear' || name === 'reset') {
    it.getParens();
    props.clear();
  } else if (name === 'setList') {
    const list = yield* f.getStringArg();
    props.clear();
    try {
      for (const [k, v] of loadProperties(list)) props.set(k, v);
    } catch (e) { if (isInternalFault(e)) throw e; it.error(errText(e)); }
  } else if (name === 'getList') {
    it.getParens();
    value = sortedKeys(props).map((k) => k + '=' + props.get(k) + '\n').join('');
  } else if (name === 'size' || name === 'getSize') {
    it.getParens();
    value = '' + props.size;
  } else if (name === 'setMeasurements' || name === 'setCommands') {
    let arg = null;
    if (name === 'setMeasurements') {
      arg = '';
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (it.nextToken() !== RP) arg = (yield* f.getString()).toLowerCase();
        it.getRightParen();
      }
    } else it.getParens();
    const r = yield* f.hostCall('List.' + name, arg === null ? [] : [arg]);
    props.clear();
    if (r && typeof r === 'object') for (const k of Object.keys(r)) props.set(k, String(r[k]));
  } else if (name === 'indexOf') {
    const key = yield* f.getStringArg();
    value = '' + sortedKeys(props).indexOf(key);
  } else if (name === 'fromArrays') {
    it.getLeftParen();
    const keys = yield* f.getStringArray();
    it.getComma();
    const values = yield* f.getStringArray();
    if (values.length !== keys.length) it.error('Arrays must have same length');
    props.clear();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === '') it.error('Key cannot be an empty string');
      props.set(keys[i], values[i]);
    }
    it.getRightParen();
  } else if (name === 'toArrays') {
    const keys = f.getFirstArrayVariable();
    const values = f.getLastArrayVariable();
    const ks = sortedKeys(props);
    keys.setArray(ks.map((k) => Variable.string(k)));
    values.setArray(ks.map((k) => Variable.string(props.get(k))));
  } else it.error('Unrecognized List function');
  return value;
}, { suspends: { setMeasurements: 'host', setCommands: 'host' } });

/* ---- String.* ---- */
define('str', K_STRING, function* (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === STRING_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'append': {
      const text = yield* f.getStringArg();
      f.buffer = (f.buffer === null ? '' : f.buffer) + text;
      return null;
    }
    case 'resetBuffer': it.getParens(); f.buffer = ''; return null;
    case 'buffer': it.getParens(); if (f.buffer === null) f.buffer = ''; return f.buffer;
    case 'join': {
      it.getLeftParen();
      const arr = yield* f.getArray();
      let delimiter = ', ';
      if (it.nextToken() === COMMA) delimiter = yield* f.getNextString();
      it.getRightParen();
      return joinArray(arr, delimiter);
    }
    case 'trim': return javaTrim(yield* f.getStringArg());
    case 'pad': return yield* padFn(f);
    case 'format': {
      let result = null;
      try {
        const command = yield* f.getFirstString();
        const params = [];
        while (it.nextToken() === COMMA) params.push(yield* f.getNextArg());
        it.getRightParen();
        result = javaFormat(command, params);
      } catch (e) {
        if (e instanceof JavaEx) it.error('' + e);
        else throw e;
      }
      return result;
    }
    case 'copy': { const text = yield* f.getStringArg(); yield* f.hostCall('String.copy', [text]); return null; }
    case 'paste': it.getParens(); return yield* f.hostCall('String.paste', []);
    case 'show': { const text = yield* f.getStringArg(); yield* f.hostCall('String.show', [text]); return null; }
    case 'copyResults': it.getParens(); yield* f.hostCall('String.copyResults', []); return null;
    case 'getResultsHeadings': it.getParens(); return yield* f.hostCall('String.getResultsHeadings', []);
    case 'setFontSize': { const size = toInt(yield* f.getArg()); yield* f.hostCall('String.setFontSize', [size]); return null; }
    default: it.error('Unrecognized String function'); return null;
  }
}, { suspends: { copy: 'host', paste: 'host', show: 'host', copyResults: 'host', getResultsHeadings: 'host', setFontSize: 'host' } });

/* ---- IJ.* ---- */
define('str', K_IJ_CALL, function* (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'pad': return yield* padFn(f);
    case 'deleteRows': {
      const first = toInt(yield* f.getFirstArg()), last = toInt(yield* f.getLastArg());
      yield* f.hostCall('IJ.deleteRows', [first, last]);
      return null;
    }
    case 'log': it.log(yield* f.getStringArg()); return null;
    case 'freeMemory': case 'currentMemory': case 'maxMemory': case 'getToolName': {
      it.getParens();
      const r = yield* f.hostCall('IJ.' + name, []);
      return r === null || r === undefined ? null : '' + r;
    }
    case 'redirectErrorMessages': it.getParens(); yield* f.hostCall('IJ.redirectErrorMessages', []); return null;
    case 'renameResults': {
      const arg1 = yield* f.getFirstString();
      let arg2 = null;
      if (it.nextToken() === RP) it.getRightParen(); else arg2 = yield* f.getLastString();
      yield* f.hostCall('IJ.renameResults', arg2 !== null ? [arg1, arg2] : [arg1]);
      return null;
    }
    case 'getFullVersion': {
      it.getParens();
      const host = it.ctx.host;
      if (host && typeof host.getFullVersion === 'function') {
        const full = yield* f.hostHook(() => host.getFullVersion());
        if (full !== undefined) return '' + full;
      }
      return IMAGEJ_VERSION + '99';   // ImageJ.VERSION + ImageJ.BUILD ("99" marks a release)
    }
    case 'checksum': {
      let method = yield* f.getFirstString();
      const src = yield* f.getLastString();
      method = method.toUpperCase();
      const file = method.indexOf('FILE') >= 0, str = method.indexOf('STRING') >= 0;
      const md = method.indexOf('MD5') >= 0, sha = method.indexOf('SHA-256') >= 0;
      if (str && md) return hex2(md5(utf8Bytes(src)));
      if (str && sha) return hex2(sha256(utf8Bytes(src)));
      if (file && (md || sha)) return yield* f.hostCall('IJ.checksum', [md ? 'MD5' : 'SHA-256', src]);
      it.error("must contain 'file' or 'string' and 'MD5' or 'SHA-256'");
      return '0';
    }
    default: it.error('Unrecognized IJ function name'); return null;
  }
}, { suspends: { deleteRows: 'host', freeMemory: 'host', currentMemory: 'host', maxMemory: 'host', getToolName: 'host', renameResults: 'host', checksum: 'host', getFullVersion: 'host', redirectErrorMessages: 'host' } });

/* ---- Array.* ---- */
/* ij.util.Tools.resampleArray: linear interpolation onto len2 points spanning the same interval. */
function resampleArray(y1, len2) {
  const len1 = y1.length;
  const y2 = new Array(len2);
  if (len1 === 1) return y2.fill(y1[0]);
  const factor = len2 === 1 ? 0 : (len1 - 1) / (len2 - 1);
  for (let j = 0; j < len2; j++) {
    const pos = j * factor;
    const i0 = Math.min(Math.floor(pos), len1 - 1), frac = pos - i0;
    y2[j] = frac === 0 || i0 + 1 >= len1 ? y1[i0] : y1[i0] * (1 - frac) + y1[i0 + 1] * frac;
  }
  return y2;
}

function* sortArray(f) {
  const it = f.interp;
  it.getLeftParen();
  const a = yield* f.getArray();
  const multipleArrays = it.nextToken() === COMMA;
  let indexes = null;
  const len = a.length;
  let nNumbers = 0;
  for (let i = 0; i < len; i++) if (a[i].getString() === null) nNumbers++;
  if (nNumbers === len) {
    const d = a.map((v) => v.getValue());
    if (multipleArrays) indexes = rankNumbers(d);
    d.sort(javaDoubleCompare);
    for (let i = 0; i < len; i++) a[i].setValue(d[i]);
  } else if (nNumbers === 0) {
    const s = a.map((v) => v.getString());
    if (multipleArrays) indexes = rankStrings(s);
    s.sort(compareToIgnoreCase);
    for (let i = 0; i < len; i++) a[i].setString(s[i]);
  } else {
    it.error('Mixed strings and numbers');
    return a;
  }
  while (it.nextToken() === COMMA) {
    it.getComma();
    const b = yield* f.getArray();
    if (b.length !== len) { it.error('Arrays must have same length'); return a; }
    const c = new Array(len);
    for (let j = 0; j < len; j++) c[j] = b[indexes[j]];
    for (let j = 0; j < len; j++) b[j] = c[j];
  }
  it.getRightParen();
  return a;
}

function* arrayStatistics(f) {
  const it = f.interp;
  it.getLeftParen();
  const a = yield* f.getArray();
  const minv = yield* f.getNextVariable();
  let maxv = null, mean = null, std = null;
  it.getToken();
  let arg = 1;
  while (it.token === COMMA) {
    arg++;
    switch (arg) {
      case 2: maxv = yield* f.getVariable(); break;
      case 3: mean = yield* f.getVariable(); break;
      case 4: std = yield* f.getVariable(); break;
      default: it.error("')' expected");
    }
    it.getToken();
  }
  if (it.token !== RP) it.error("')' expected");
  const n = a.length;
  let sum = 0.0, sum2 = 0.0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const value = a[i].getValue();
    sum += value; sum2 += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  minv.setValue(min);
  if (maxv !== null) maxv.setValue(max);
  if (mean !== null) mean.setValue(sum / n);
  if (std !== null) {
    let stdDev = (n * sum2 - sum * sum) / n;
    stdDev = Math.sqrt(stdDev / (n - 1.0));
    std.setValue(stdDev);
  }
  return a;
}

/* Array.show: parsed as ImageJ does, shown by the host (host.call('Array.show', [title, names, columns])). */
function* showArray(f) {
  const it = f.interp;
  let title = 'Arrays';
  const arrays = [], names = [];
  it.getLeftParen();
  do {
    if (f.isStringArg() && !f.isArrayArg()) title = yield* f.getString();
    else {
      const addr = f.pgm.code[it.pc + 1] >> TOK_SHIFT;
      names.push(f.pgm.table[addr].str);
      arrays.push(yield* f.getArray());
    }
    it.getToken();
  } while (it.token === COMMA);
  if (it.token !== RP) it.error("')' expected");
  if (arrays.length === 1 && title === 'Arrays') title = names[0];
  const cols = arrays.map((a) => a.map((v) => (v.getString() !== null ? v.getString() : v.getValue())));
  yield* f.hostCall('Array.show', [title, arrays.length === 1 ? ['Value'] : names, cols]);
  return null;
}

define('arr', K_ARRAY_FUNC, function* (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === PREDEFINED_FUNCTION || it.token === STRING_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'copy': {
      it.getLeftParen();
      const a = yield* f.getArray();
      it.getRightParen();
      return duplicate(a);
    }
    case 'trim': {
      it.getLeftParen();
      const a1 = yield* f.getArray();
      let size = toInt(yield* f.getLastArg());
      if (size < 0) size = 0;
      if (size > a1.length) size = a1.length;
      return duplicate(a1.slice(0, size));
    }
    case 'sort': return yield* sortArray(f);
    case 'rankPositions': {
      it.getLeftParen();
      const a = yield* f.getArray();
      it.getRightParen();
      const len = a.length;
      let nNumbers = 0;
      for (let i = 0; i < len; i++) if (a[i].getString() === null) nNumbers++;
      if (nNumbers !== len && nNumbers !== 0) { it.error('Mixed strings and numbers'); return a; }
      const indexes = nNumbers === len ? rankNumbers(a.map((v) => v.getValue())) : rankStrings(a.map((v) => v.getString()));
      return indexes.map((x) => Variable.num(x));
    }
    case 'getStatistics': return yield* arrayStatistics(f);
    case 'sequence': case 'getSequence': {
      const n = toInt(yield* f.getArg());
      if (n < 0) { it.error('Negative array size'); return []; }
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = Variable.num(i);
      return a;
    }
    case 'fill': {
      it.getLeftParen();
      const a = yield* f.getArray();
      const v = yield* f.getLastArg();
      for (let i = 0; i < a.length; i++) a[i].setValue(v);
      return a;
    }
    case 'reverse': case 'invert': {
      it.getLeftParen();
      const a = yield* f.getArray();
      it.getRightParen();
      const n = a.length;
      for (let i = 0; i < Math.floor(n / 2); i++) { const t = a[i]; a[i] = a[n - i - 1]; a[n - i - 1] = t; }
      return a;
    }
    case 'concat': {
      it.getLeftParen();
      const list = [];
      do {
        if (f.isArrayArg()) { for (const v of yield* f.getArray()) list.push(v.clone()); }
        else if (f.isStringArg()) list.push(Variable.string(yield* f.getString()));
        else list.push(Variable.num(yield* it.getExpression()));
        it.getToken();
      } while (it.token === COMMA);
      return list;
    }
    case 'slice': {
      it.getLeftParen();
      const a = yield* f.getArray();
      const len = a.length;
      let i1 = toInt(yield* f.getNextArg());
      let i2 = len;
      if (it.nextToken() === COMMA) { it.getComma(); i2 = toInt(yield* it.getExpression()); }
      if (i1 < 0) it.error('Invalid argument');
      if (i2 > len) i2 = len;
      let len2 = i2 - i1;
      if (len2 < 0) len2 = 0;
      if (len2 > len) len2 = len;
      it.getRightParen();
      const a2 = new Array(len2);
      for (let i = 0; i < len2; i++) a2[i] = a[i1++].clone();
      return a2;
    }
    case 'print': {
      let prefix = null;
      it.getLeftParen();
      if (!f.isArrayArg() && f.isStringArg()) { prefix = yield* f.getString(); it.getComma(); }
      const a = yield* f.getArray();
      it.getRightParen();
      let str = joinArray(a, ', ');
      if (prefix !== null) str = prefix + ' ' + str;
      it.log(str);
      return null;
    }
    case 'resample': {
      it.getLeftParen();
      const a1 = yield* f.getArray();
      const len1 = a1.length;
      const len2 = toInt(yield* f.getLastArg());
      if (len1 === 0 || len2 <= 0) { it.error('Cannot resample from or to zero-length'); return []; }
      return resampleArray(a1.map((v) => v.getValue()), len2).map((x) => Variable.num(x));
    }
    case 'findMaxima': case 'findMinima': {
      let edgeMode = 0;
      it.getLeftParen();
      const a = yield* f.getArray();
      const tolerance = yield* f.getNextArg();
      if (it.nextToken() === COMMA) { it.getComma(); edgeMode = toInt(yield* it.getExpression()); }
      it.getRightParen();
      const d = a.map((v) => v.getValue());
      const res = name === 'findMinima' ? findMaxima1D(d.map((x) => -x), tolerance, edgeMode) : findMaxima1D(d, tolerance, edgeMode);
      return res.map((x) => Variable.num(x));
    }
    case 'show': return yield* showArray(f);
    case 'fourier': {
      it.getLeftParen();
      const a = yield* f.getArray();
      let windowType = 'none';
      if (it.nextToken() === COMMA) {
        it.getComma();
        const w = (yield* f.getString()).toLowerCase();
        if (w === 'hamming') windowType = 'hamming';
        else if (w.startsWith('hann')) windowType = 'hann';
        else if (w.startsWith('flat')) windowType = 'flat';
        else if (!w.startsWith('no')) it.error("Invalid Fourier window '0'");
      }
      it.getRightParen();
      const n = a.length;
      if (windowType !== 'none' || n < 2 || (n & (n - 1)) !== 0) {
        it.error('Function not available in the browser: Array.fourier (only the "none" window on a power-of-two length is reproduced)');
        return [];
      }
      return fourierAmplitudes(a.map((v) => Math.fround(v.getValue()))).map((x) => Variable.num(x));
    }
    case 'getVertexAngles': {
      it.getLeftParen();
      const xx = yield* f.getArray();
      it.getComma();
      const yy = yield* f.getArray();
      it.getComma();
      const arm = toInt(yield* it.getExpression());
      const len = xx.length;
      if (yy.length !== len) it.error('Same size expected');
      it.getRightParen();
      const x = xx.map((v) => v.getValue()), y = yy.map((v) => v.getValue());
      const out = new Array(len);
      for (let mid = 0; mid < len; mid++) {
        const left = (mid + 10 * len - arm) % len, right = (mid + arm) % len;
        const dot = (x[right] - x[mid]) * (x[left] - x[mid]) + (y[right] - y[mid]) * (y[left] - y[mid]);
        const cross = (x[right] - x[mid]) * (y[left] - y[mid]) - (y[right] - y[mid]) * (x[left] - x[mid]);
        let phi = 180.0 - 180.0 / Math.PI * Math.atan2(cross, dot);
        while (phi >= 180.0) phi -= 360.0;
        out[mid] = Variable.num(phi);
      }
      return out;
    }
    case 'rotate': {
      it.getLeftParen();
      const a = yield* f.getArray();
      it.getComma();
      let rot = toInt(yield* it.getExpression());
      it.getRightParen();
      const len = a.length;
      if (len === 0) return a;
      while (rot < 0) rot += len;
      const b = new Array(len);
      for (let i = 0; i < len; i++) b[(i + rot) % len] = a[i];
      for (let i = 0; i < len; i++) a[i] = b[i];
      return a;
    }
    case 'deleteValue': case 'delete': {
      it.getLeftParen();
      const arr1 = yield* f.getArray();
      let value = Number.MAX_VALUE, stringValue = null;
      it.getComma();
      if (f.isStringArg()) stringValue = yield* f.getString();
      else value = yield* it.getExpression();
      it.getRightParen();
      const out = [];
      for (const v of arr1) {
        const type = v.getType();
        let remove = false;
        if (stringValue !== null) {
          if (type === V_STRING) remove = stringValue === v.getString();
        } else if (type === V_VALUE) {
          const val = v.getValue();
          remove = val === value || (val !== val && value !== value);
        }
        if (!remove) out.push(v.clone());
      }
      return out;
    }
    case 'deleteIndex': {
      it.getLeftParen();
      const arr1 = yield* f.getArray();
      const index = toInt(yield* f.getLastArg());
      f.checkIndex(index, 0, arr1.length - 1);
      const out = [];
      for (let i = 0; i < arr1.length; i++) if (i !== index) out.push(arr1[i].clone());
      return out;
    }
    case 'filter': {
      it.getLeftParen();
      const a1 = yield* f.getArray();
      const filter = yield* f.getLastString();
      const out = [];
      for (const v of a1) {
        const str = v.getString();
        if (str === null) continue;
        let contains;
        if (filter.startsWith('(') && filter.endsWith(')')) {
          try { contains = javaRegex(filter.substring(1, filter.length - 1), false).test(str); }
          catch (e) { if (isInternalFault(e)) throw e; it.error(errText(e)); return []; }
        } else contains = str.indexOf(filter) >= 0;
        if (contains) out.push(v);
      }
      return out;
    }
    default:
      it.error('Unrecognized Array function');
      return null;
  }
}, { suspends: { show: 'host' } });

/* ---- statements that need no image ---- */
/* Functions.setOption: ExpandableArrays is the interpreter's own; every other option is the host's. */
define('do', K_SET_OPTION, function* (f) {
  const it = f.interp;
  const arg1 = yield* f.getFirstString();
  let state = true;
  if (it.nextToken() === COMMA) {
    it.getComma();
    const arg2 = yield* it.getBooleanExpression();
    it.checkBoolean(arg2);
    state = arg2 !== 0;
  }
  it.getRightParen();
  if (arg1.toLowerCase().startsWith('expandablearrays')) f.expandableArrays = state;
  else yield* f.hostCall('setOption', [arg1, state]);
}, { suspends: 'host' });
/* Functions.wait: Thread.sleep, as a timer the driver awaits (the slice loop keeps the page responsive). */
define('do', K_WAIT, function* (f) {
  const n = toInt(yield* f.getArg());
  if (n > 0) {
    const sig = f.interp.ctx.signal;
    yield new Promise((resolve) => {
      const done = () => { clearTimeout(t); if (sig) sig.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, n);
      if (sig) sig.addEventListener('abort', done, { once: true });
    });
  }
}, { suspends: true });
/* Functions.showMessage: IJ.showMessage(title, message) through the host's dialog hook. */
define('do', K_SHOW_MESSAGE, function* (f) {
  const it = f.interp;
  it.getLeftParen();
  let title = yield* f.getString();
  let message;
  if (it.nextToken() === COMMA) { it.getComma(); message = yield* f.getString(); }
  else { message = title; title = ''; }
  it.getRightParen();
  yield* f.showMessage(title, message);
}, { suspends: true });

/* ======================================================================================
 * Synchronous fast path
 *
 * The interpreter above is a set of generators so that a host built-in may return a Promise (the driver awaits it).
 * A generator costs about 3x a plain function; most statements of a macro never wait. So every generator method of
 * Interpreter / Functions has a generated plain-function twin (suffix $s, installed on the SAME prototypes: both paths
 * read and write the same state objects, the same tokens are consumed, the same errors and lines come out).
 * tools/gen_ijm_sync.mjs writes the twin between the markers below; this file's generators stay the only source.
 *
 * Dispatch (Interpreter.doStatement, the loop bodies, doBlock, doIf, user-function bodies): a statement that CANNOT
 * SUSPEND runs in the twin as a whole. "Cannot suspend" is decided from the tokens, once per statement start
 * (SyncAnalysis.classify, memoised in Interpreter.syncMemo):
 *   - a built-in may suspend when it is registered { suspends: true }, or 'host' (a built-in that reaches the host: it
 *     may suspend unless ctx.host.syncFunctions, a Set of names such as 'getPixel' or 'List.setMeasurements', declares
 *     it synchronous), or a { sub: ... } map for a namespace (Array.show), or a predicate (pgm, tokenIndex, host);
 *     a built-in defined later through IJMacro.define() without an option defaults to 'host';
 *   - a user function may suspend when its body does, transitively (fixed point over the call graph), or calls a name
 *     that is not a known function;
 *   - eval() / runMacro() / wait() / showMessage() / requires() / exit("msg") / print("[Window]", ..) are registered so.
 * A statement with a loop in it (or a call to a function that has one) that cannot suspend is class SYNC_LOOP: the
 * generator keeps the loop CONTROL (so the event loop is released and an abort is honoured every TICK_MASK+1
 * iterations, exactly as before) while the loop header and every body statement run in the twin, with no generator
 * allocated per iteration. Everything else is SYNC_GEN: executed by the generators, which dispatch their own inner
 * statements the same way.
 *
 * A user function on a cycle of the call graph (recursion, direct or through others) counts like a loop: a statement that
 * calls into it is SYNC_LOOP, so the call runs on the generators, which slice every TICK_MASK+1 calls (an abort is
 * honoured within sliceMs) and hop to a fresh native stack every FN_NEST_STEP levels (ImageJ's 1000 levels fit). Only the
 * statements of the body that do not call into the cycle stay in the twin. A page is not cross-origin isolated here, so a
 * SharedArrayBuffer abort flag cannot exist, and a timer cannot fire while the twin holds the thread: letting a recursion
 * run whole in the twin (option syncRecursion) therefore means it cannot be stopped short of terminating the worker.
 *
 * Policy for a stretch that runs in the twin and cannot yield (a loop-free, recursion-free statement: a long pure
 * built-in): it keeps the thread until it ends. Every SYNC_TICK_MASK+1 (1024) user-function calls it looks at
 * ctx.abortFlag (an Int32Array on a SharedArrayBuffer the host sets to non-zero; Atomics.load) and at signal.aborted,
 * and throws the "Macro canceled" path; that only helps where a SharedArrayBuffer exists or when the signal was aborted
 * before the stretch. ctx.syncLoops / ctx.syncRecursion (options) let loops / recursions run whole in the twin
 * (fastest, same limit); ctx.fastPath === false (option fastPath) turns the whole mechanism off.
 * ==================================================================================== */
class SyncViolation { constructor(m) { this.message = m || 'a built-in that may suspend ran in the synchronous fast path'; } }
/* What a catch that turns a library failure into a macro error must let through: a defect of the host wiring and a native
 * stack overflow are not the macro's error (the latter is reported as ImageJ's "Stack overflow" by run()). */
function isInternalFault(e) {
  return e instanceof SyncViolation || (e instanceof RangeError && /call stack/i.test(e.message));
}
/* The result of a built-in in the twin: an iterator means a generator was returned instead of driven. */
function syncResult(r) {
  if (r !== null && typeof r === 'object' && typeof r.next === 'function') throw new SyncViolation('a built-in of the fast path returned a generator');
  return r;
}
function syncAwait(v) {
  if (isThenable(v)) throw new SyncViolation();
  return v;
}
/* A built-in written as a generator (an external IJMacro.define) run to completion without a driver. */
function runSyncGen(r) {
  if (!isIterator(r)) return r;
  let s = r.next();
  while (!s.done) {
    const y = s.value;
    if (y instanceof Sub) {
      let v;
      try { v = runSyncGen(y.gen); } catch (e) { s = r.throw(e); continue; }
      s = r.next(v);
    } else if (y === SLICE) s = r.next();
    else throw new SyncViolation();
  }
  return s.value;
}
const BUILTINS_S = {};
for (const kind of Object.keys(BUILTINS)) {
  const twin = new Map(), wrapped = new Map();
  BUILTINS_S[kind] = {
    set(id, fn) { twin.set(id, fn); },
    delete(id) { twin.delete(id); wrapped.delete(id); },
    get(id) {
      const t = twin.get(id);
      if (t !== undefined) return t;
      const gen = BUILTINS[kind].get(id);
      if (gen === undefined) return undefined;
      let w = wrapped.get(id);
      if (w === undefined) { w = (f) => runSyncGen(gen(f)); wrapped.set(id, w); }
      return w;
    },
  };
}
const defineS = (kind, id, fn) => { BUILTINS_S[kind].set(id, fn); };

/* host.syncFunctions: is `full` ('getPixel', 'List.get') declared synchronous? 'List.*' and 'List' cover a namespace. */
function hostDeclaresSync(host, full) {
  const set = host && host.syncFunctions;
  if (!set || typeof set.has !== 'function') return false;
  if (set.has(full)) return true;
  const dot = full.indexOf('.');
  return dot > 0 && (set.has(full.slice(0, dot) + '.*') || set.has(full.slice(0, dot)));
}
function suspendsNow(spec, name, sub, host, pgm, j) {
  if (spec === false || spec === undefined || spec === null) return false;
  if (spec === true) return true;
  if (spec === 'host') return !hostDeclaresSync(host, sub === null ? name : name + '.' + sub);
  if (typeof spec === 'function') return !!spec(pgm, j, host);
  if (sub === null) return false;
  const one = spec[sub];
  return one === undefined ? false : suspendsNow(one, name, sub, host, pgm, j);
}
/* print(a, b): the window form print("[Title]", text) is the only way print reaches the host; it needs a comma, and a
 * first argument that is not a literal that cannot be "[...]". */
function printSuspends(pgm, j, host) {
  const code = pgm.code;
  if ((code[j + 1] & TOK_MASK) !== LP) return false;
  let depth = 0;
  for (let k = j + 1; k < code.length; k++) {
    const t = code[k] & TOK_MASK;
    if (t === LP || t === LSQ) depth++;
    else if (t === RP || t === RSQ) { if (--depth <= 0) return false; }
    else if (t === EOF || t === SEMI) return false;
    else if (t === COMMA && depth === 1) {
      const first = code[j + 2], ft = first & TOK_MASK;
      /* sound only while a literal is followed by `,` or `+`: a method on a literal ("[Log]".substring(0)) could build a window title */
      const after = code[j + 3] & TOK_MASK, plain = after === COMMA || after === C('+');
      if (ft === NUMBER && plain) return false;
      if (ft === STRING_CONSTANT && plain) { const str = pgm.table[first >> TOK_SHIFT].str; if (str.length > 0 && str.charAt(0) !== '[') return false; }
      return !hostDeclaresSync(host, 'printToWindow');
    }
  }
  return false;
}
/* exit("message") shows a dialog; a bare exit does not. */
function exitSuspends(pgm, j) {
  const code = pgm.code;
  return (code[j + 1] & TOK_MASK) === LP && (code[j + 2] & TOK_MASK) !== RP;
}

class SyncAnalysis {
  constructor(pgm, ctx) {
    this.pgm = pgm;
    this.host = ctx.host || null;
    this.syncLoops = ctx.syncLoops === true;
    this.syncRecursion = ctx.syncRecursion === true;
    this.fns = null;   // symbol address -> { susp, loopy, rec, from, to, calls }
  }

  /* Index just after the parenthesised group that opens at k, or -1. */
  parensEnd(k) {
    const code = this.pgm.code, n = code.length;
    if (k >= n || (code[k] & TOK_MASK) !== LP) return -1;
    let depth = 0;
    for (; k < n; k++) {
      const t = code[k] & TOK_MASK;
      if (t === LP) depth++;
      else if (t === RP) { if (--depth === 0) return k + 1; }
      else if (t === EOF) return -1;
    }
    return -1;
  }
  blockEnd(k) {
    const code = this.pgm.code, n = code.length;
    if (k >= n || (code[k] & TOK_MASK) !== LBRACE) return -1;
    let depth = 0;
    for (; k < n; k++) {
      const t = code[k] & TOK_MASK;
      if (t === LBRACE) depth++;
      else if (t === RBRACE) { if (--depth === 0) return k + 1; }
      else if (t === EOF) return -1;
    }
    return -1;
  }
  /* Index just after the statement that starts at i (an upper bound: a simple statement runs to its `;`), or -1 for
   * something that is not a statement of the dispatcher (macro, function, else, EOF ...). */
  stmtEnd(i) {
    const code = this.pgm.code, n = code.length;
    if (i >= n) return -1;
    const t = code[i] & TOK_MASK;
    switch (t) {
      case K_IF: {
        const p = this.parensEnd(i + 1);
        if (p < 0) return -1;
        let e = this.stmtEnd(p);
        if (e < 0) return -1;
        let k = e;
        if (k < n && (code[k] & TOK_MASK) === SEMI) k++;
        if (k < n && (code[k] & TOK_MASK) === K_ELSE) e = this.stmtEnd(k + 1);
        return e;
      }
      case K_FOR: case K_WHILE: {
        const p = this.parensEnd(i + 1);
        return p < 0 ? -1 : this.stmtEnd(p);
      }
      case K_DO: {
        const e = this.stmtEnd(i + 1);
        if (e < 0 || e >= n || (code[e] & TOK_MASK) !== K_WHILE) return -1;
        return this.parensEnd(e + 1);
      }
      case LBRACE: return this.blockEnd(i);
      case SEMI: case K_BREAK: case K_CONTINUE: return i + 1;
      case K_VAR: case PREDEFINED_FUNCTION: case USER_FUNCTION: case WORD: case LP: case K_PLUS_PLUS: case K_RETURN:
      case ARRAY_FUNCTION: case NUMERIC_FUNCTION: case STRING_FUNCTION: case VARIABLE_FUNCTION: case NUMBER: case STRING_CONSTANT: {
        for (let j = i; j < n; j++) {
          const tj = code[j] & TOK_MASK;
          if (tj === SEMI) return j + 1;
          if (tj === RBRACE || tj === EOF) return j;
        }
        return n;
      }
      default: return -1;
    }
  }

  tokenSuspends(j, t) {
    const code = this.pgm.code;
    const kind = t === PREDEFINED_FUNCTION ? 'do' : t === NUMERIC_FUNCTION ? 'num' : t === STRING_FUNCTION ? 'str' : t === ARRAY_FUNCTION ? 'arr' : 'variable';
    const id = this.pgm.table[code[j] >> TOK_SHIFT].type;
    const info = BUILTIN_INFO[kind].get(id);
    if (info === undefined) return false;
    let sub = null;
    if (code[j + 1] === DOT && code[j + 2] > 127) { const s2 = this.pgm.table[code[j + 2] >> TOK_SHIFT]; if (s2 && typeof s2.str === 'string') sub = s2.str; }
    return suspendsNow(info.suspends, NAME_OF[id] || '', sub, this.host, this.pgm, j);
  }

  /* All user functions: may it suspend, does it loop (itself or through a callee). */
  functions() {
    if (this.fns !== null) return this.fns;
    const { code, table } = this.pgm;
    const fns = new Map();
    for (let a = SYSTEM_TABLE.length; a < table.length; a++) {
      const sym = table[a];
      if (!sym || sym.type !== USER_FUNCTION) continue;
      const from = sym.value;
      const p = this.parensEnd(from + 1);
      const to = p < 0 ? -1 : this.blockEnd(p);
      const f = { susp: to < 0, loopy: false, rec: false, from, to, calls: [] };
      if (to >= 0)
        for (let j = from; j < to; j++) {
          const t = code[j] & TOK_MASK;
          if (t === K_FOR || t === K_WHILE || t === K_DO) f.loopy = true;
          else if (t === USER_FUNCTION) f.calls.push(code[j] >> TOK_SHIFT);
          else if ((t >= PREDEFINED_FUNCTION && t <= ARRAY_FUNCTION) || t === VARIABLE_FUNCTION) { if (this.tokenSuspends(j, t)) f.susp = true; }
        }
      fns.set(a, f);
    }
    /* A function on a cycle of the call graph (itself or through others) is recursive: like a loop it must not run whole in
     * the twin, which cannot yield and cannot hop to a fresh native stack (ImageJ's 1000 levels do not fit a worker's). */
    for (const [a, f] of fns) {
      const seen = new Set(), todo = f.calls.slice();
      while (todo.length > 0) {
        const b = todo.pop();
        if (b === a) { f.rec = true; break; }
        if (seen.has(b)) continue;
        seen.add(b);
        const c = fns.get(b);
        if (c !== undefined) for (const x of c.calls) todo.push(x);
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const f of fns.values())
        for (const a of f.calls) {
          const c = fns.get(a);
          if (c === undefined) { if (!f.susp) { f.susp = true; changed = true; } continue; }
          if (c.susp && !f.susp) { f.susp = true; changed = true; }
          if (c.loopy && !f.loopy) { f.loopy = true; changed = true; }
          if (c.rec && !f.rec) { f.rec = true; changed = true; }
        }
    }
    return (this.fns = fns);
  }

  classify(i) {
    const code = this.pgm.code;
    const end = this.stmtEnd(i);
    if (end < 0) return SYNC_GEN;
    let loopy = false, rec = false;
    for (let j = i; j < end; j++) {
      const t = code[j] & TOK_MASK;
      if (t === K_FOR || t === K_WHILE || t === K_DO) loopy = true;
      else if (t === K_MACRO || t === K_FUNCTION) return SYNC_GEN;
      else if (t === USER_FUNCTION) {
        const f = this.functions().get(code[j] >> TOK_SHIFT);
        if (f === undefined || f.susp) return this.classifyGen(i);
        if (f.loopy) loopy = true;
        if (f.rec) rec = true;
      } else if ((t >= PREDEFINED_FUNCTION && t <= ARRAY_FUNCTION) || t === VARIABLE_FUNCTION) {
        if (this.tokenSuspends(j, t)) return this.classifyGen(i);
      }
    }
    return (loopy && !this.syncLoops) || (rec && !this.syncRecursion) ? SYNC_LOOP : SYNC_TWIN;
  }

  /* classify() for a statement that may suspend: SYNC_HDR when the parenthesised header of an if / for / while cannot. */
  classifyGen(i) {
    const code = this.pgm.code;
    const t = code[i] & TOK_MASK;
    if (t !== K_IF && t !== K_FOR && t !== K_WHILE) return SYNC_GEN;
    const p = this.parensEnd(i + 1);
    if (p < 0) return SYNC_GEN;
    for (let j = i; j < p; j++) {
      const tj = code[j] & TOK_MASK;
      if (tj === USER_FUNCTION) {
        const f = this.functions().get(code[j] >> TOK_SHIFT);
        if (f === undefined || f.susp || f.loopy || (f.rec && !this.syncRecursion)) return SYNC_GEN;
      } else if ((tj >= PREDEFINED_FUNCTION && tj <= ARRAY_FUNCTION) || tj === VARIABLE_FUNCTION) {
        if (this.tokenSuspends(j, tj)) return SYNC_GEN;
      }
    }
    return SYNC_HDR;
  }
}

/* BEGIN GENERATED SYNC TWIN: written by tools/gen_ijm_sync.mjs from the generator code of this file. GENERATED, DO NOT EDIT.
 * Plain-function twin of class Interpreter / class Functions and of the built-ins, installed on the same prototypes
 * (suffix $s) so both paths share every state object. Run `node tools/gen_ijm_sync.mjs` after any edit above;
 * tests/js/test_ijm_sync_twin.mjs fails when this region is stale. */
Object.assign(Interpreter.prototype, {
  run$s(macro) {
    const pgm = tokenize(macro);
    if (pgm.hasVars && pgm.hasFunctions) this.saveGlobals2$s(pgm);
    this.runProgram$s(pgm);
  },
  runProgram$s(pgm) {
    this.pgm = pgm;
    this.pc = -1;
    this.callDepth = 0;
    this.syncReset();
    this.pushGlobals();
    if (this.func === null) this.func = new Functions(this, pgm); else this.func.pgm = pgm;
    this.done = false;
    this.errorMessage = null;
    this.doStatements$s();
    this.finishUp();
  },
  saveGlobals2$s(pgm) {
    this.pgm = pgm;
    this.pc = -1;
    this.func = new Functions(this, pgm);
    while (!this.done) {
      this.getToken();
      switch (this.token) {
        case K_VAR: this.doVar$s(); break;
        case K_MACRO: this.skipMacro(); break;
        case K_FUNCTION: this.skipFunction(); break;
        default:
      }
    }
    if (this.topOfStack !== -1) {
      const n = this.topOfStack + 1;
      pgm.globals = new Array(n);
      for (let i = 0; i < n; i++) pgm.globals[i] = this.stack[i];
    }
    this.pc = -1;
    this.topOfStack = -1;
    this.done = false;
  },
  doStatements$s() {
    while (!this.done) this.doStatement$s();
  },
  doStatement$s() {
    this.getToken();
    switch (this.token) {
      case K_VAR:
        this.doVar$s();
        break;
      case PREDEFINED_FUNCTION:
        this.func.doFunction$s(this.pgm.table[this.tokenAddress].type);
        break;
      case USER_FUNCTION:
        this.runUserFunction$s();
        break;
      case K_RETURN:
        this.doReturn$s();
        break;
      case K_BREAK:
        if (this.inLoop) throw new MacroException(K_BREAK);
        break;
      case K_CONTINUE:
        if (this.inLoop) throw new MacroException(K_CONTINUE);
        break;
      case WORD:
        if (this.pgm.code[this.pc + 1] === DOT) this.doStringFunction$s();
        else this.doAssignment$s();
        break;
      case K_IF:
        this.doIf$s();
        return;
      case K_ELSE:
        this.error('Else without if');
        return;
      case K_FOR:
        this.doFor$s();
        return;
      case K_WHILE:
        this.doWhile$s();
        return;
      case K_DO:
        this.doDo$s();
        return;
      case K_MACRO:
        this.runFirstMacro$s();
        return;
      case K_FUNCTION:
        this.skipFunction();
        return;
      case SEMI:
        return;
      case LBRACE:
        this.putTokenBack();
        this.doBlock$s();
        return;
      case NUMBER: case NUMERIC_FUNCTION: case STRING_FUNCTION: case STRING_CONSTANT:
      case VARIABLE_FUNCTION: case LP: {
        this.putTokenBack();
        this.inPrint = true;
        const s = this.getString$s();
        this.inPrint = false;
        if (s !== null && s.length > 0 && s !== 'NaN' && s !== '[aborted]') this.log(s);
        return;
      }
      case ARRAY_FUNCTION:
        this.func.getArrayFunction$s(this.pgm.table[this.tokenAddress].type);
        break;
      case EOF:
        break;
      default:
        if (this.evaluating && this.token === K_PI) {
          this.putTokenBack();
          this.log('' + javaDouble(this.getExpression$s()));
        } else
          this.error("Statement cannot begin with '" + this.pgm.decodeToken(this.token, this.tokenAddress) + "'");
    }
    if (!this.looseSyntax) {
      this.getToken();
      if (this.token !== SEMI && !this.done) this.error("';' expected");
    }
  },
  doStringFunction$s() {
    const stringFunction = (this.pgm.code[this.pc + 2] & 0xff) === STRING_FUNCTION;
    this.putTokenBack();
    let s = stringFunction ? this.getString$s() : javaDouble(this.getExpression$s());
    if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
    this.ctx.log(s);
  },
  runUserFunction$s() {
    this.growCallStack(1);
    if ((++this.ticks & SYNC_TICK_MASK) === 0) this.syncCheck();
    const newPC = toInt(this.tokenValue);
    const saveStartOfLocals = this.startOfLocals;
    this.startOfLocals = this.topOfStack + 1;
    const saveTOS = this.topOfStack;
    const nArgs = this.pushArgs$s();
    const savePC = this.pc;
    let value = null;
    this.pc = newPC;
    this.setupArgs(nArgs);
    const saveInFunction = this.inFunction;
    this.inFunction = true;
    try {
      if ((++this.fnNest % FN_NEST_STEP) === 0) this.doBlock$s();
      else this.doBlock$s();
    } catch (e) {
      if (!(e instanceof ReturnException)) throw e;
      value = new Variable(0, e.value, e.str, e.array);
      if (value.getArray() !== null && e.arraySize !== 0) value.setArraySize(e.arraySize);
    }
    this.fnNest--;
    this.inFunction = saveInFunction;
    this.pc = savePC;
    this.trimStack(saveTOS, saveStartOfLocals);
    this.growCallStack(-1);
    return value;
  },
  pushArgs$s() {
    this.getLeftParen();
    let count = 0;
    const args = new Array(MAX_ARGS);
    const code = this.pgm.code;
    if (this.nextToken() !== RP) {
      do {
        if (count === MAX_ARGS) this.error('Too many arguments');
        const next = this.nextToken();
        const nextPlus = code[this.pc + 2] & 0xff;
        if (next === STRING_CONSTANT || next === STRING_FUNCTION)
          args[count] = new Variable(0, 0.0, this.getString$s());
        else if (next === USER_FUNCTION) {
          const savePC = this.pc;
          this.getToken();   // the function
          const simpleFunctionCall = this.isSimpleFunctionCall(false);
          this.pc = savePC;
          if (simpleFunctionCall) {
            this.getToken();   // the function
            const v2 = this.runUserFunction$s();
            if (v2 === null) this.error('No return value');
            args[count] = v2;
          } else
            args[count] = new Variable(0, this.getExpression$s(), null);
        } else if (next === WORD && (nextPlus === COMMA || nextPlus === RP)) {
          let value = 0.0, array = null, arraySize = 0, str = null;
          this.getToken();
          const v = this.lookupVariable();
          if (v !== null) {
            const type = v.getType();
            if (type === V_VALUE) value = v.getValue();
            else if (type === V_ARRAY) { array = v.getArray(); arraySize = v.getArraySize(); }
            else str = v.getString();
          }
          args[count] = new Variable(0, value, str, array);
          if (array !== null) args[count].setArraySize(arraySize);
        } else if (next === WORD && nextPlus === LSQ) {
          const savePC = this.pc;
          this.getToken();
          let v = this.lookupVariable();
          v = this.getArrayElement$s(v);
          if (v.getString() !== null) args[count] = new Variable(0, 0.0, v.getString(), null);
          else {
            this.pc = savePC;
            args[count] = new Variable(0, this.getExpression$s(), null);
          }
        } else if (next === WORD && nextPlus === DOT) {   // s.length, s.substring(), etc.
          const stringFunction = (code[this.pc + 3] & 0xff) === 136;
          if (stringFunction) args[count] = new Variable(0, 0.0, this.func.getString$s(), null);
          else args[count] = new Variable(0, this.getExpression$s(), null);
        } else if (nextPlus === C('+') && next === WORD) {
          const savePC = this.pc;
          this.getToken();
          const v = this.lookupVariable();
          const isString = v !== null && v.getType() === V_STRING;
          this.pc = savePC;
          if (isString) args[count] = new Variable(0, 0.0, this.getString$s());
          else args[count] = new Variable(0, this.getExpression$s(), null);
        } else if (next === ARRAY_FUNCTION) {
          this.getToken();
          const array = this.func.getArrayFunction$s(this.pgm.table[this.tokenAddress].type);
          args[count] = new Variable(0, 0, null, array);
        } else
          args[count] = new Variable(0, this.getExpression$s(), null);
        count++;
        this.getToken();
      } while (this.token === COMMA);
      this.putTokenBack();
    }
    const nArgs = count;
    while (count > 0) this.push(args[--count], this);
    this.getRightParen();
    return nArgs;
  },
  doReturn$s() {
    let value = 0.0, str = null, array = null, arraySize = 0;
    this.getToken();
    if (this.token === LP) {
      const next = this.pgm.code[this.pc + 1];
      if ((next & TOK_MASK) === STRING_CONSTANT || (next & TOK_MASK) === STRING_FUNCTION || this.isString(this.pc + 1))
        this.error('String enclosed in parens');
    }
    if (this.token !== SEMI) {
      let isString = this.token === STRING_CONSTANT || this.token === STRING_FUNCTION;
      const isArrayFunction = this.token === ARRAY_FUNCTION;
      if (this.token === WORD) {
        const v = this.lookupLocalVariable(this.tokenAddress);
        if (v !== null && this.nextToken() === SEMI) {
          array = v.getArray();
          if (array !== null) arraySize = v.getArraySize();
          isString = v.getString() !== null;
        } else if (v !== null && this.nextToken() === C('+'))
          isString = v.getType() === V_STRING;
      }
      this.putTokenBack();
      if (isString) str = this.getString$s();
      else if (isArrayFunction) {
        this.getToken();
        array = this.func.getArrayFunction$s(this.pgm.table[this.tokenAddress].type);
      } else if (array === null) {
        if ((this.pgm.code[this.pc + 2] & 0xff) === LSQ && this.nextToken() === WORD) {
          const savePC = this.pc;
          this.getToken();
          let v = this.lookupVariable();
          v = this.getArrayElement$s(v);
          this.pc = savePC;
          if (v.getString() !== null) str = this.getString$s();
          else value = this.getExpression$s();
        } else
          value = this.getExpression$s();
      }
    }
    if (this.inFunction) {
      if (this.returnException === null) this.returnException = new ReturnException();
      const r = this.returnException;
      r.value = value; r.str = str; r.array = array; r.arraySize = arraySize;
      throw r;
    } else {
      this.finishUp();
      if (value !== 0.0 || array !== null) this.error('Macros can only return strings');
      this.returnValue = str;
      this.done = true;
    }
  },
  doFor$s() {
    const fast = true;
    const saveLooseSyntax = this.looseSyntax;
    this.looseSyntax = false;
    this.loopDepth++;
    this.inLoop = true;
    this.getToken();
    if (this.token !== LP) this.error("'(' expected");
    this.getToken();   // skip 'var'
    if (this.token !== K_VAR) this.putTokenBack();
    do {
      if (this.nextToken() !== SEMI) { if (fast) this.getAssignmentExpression$s(); else this.getAssignmentExpression$s(); }
      this.getToken();
    } while (this.token === COMMA);
    if (this.token !== SEMI) this.error("';' expected");
    const condPC = this.pc;
    let startPC = 0;
    let cond = 1;
    const code = this.pgm.code;
    for (;;) {
      if (code[this.pc + 1] !== SEMI) cond = fast ? this.getLogicalExpression$s() : this.getLogicalExpression$s();
      if (startPC === 0) this.checkBoolean(cond);
      this.getToken();
      if (this.token !== SEMI) this.error("';' expected");
      const incPC = this.pc;
      // skip to start of code
      if (startPC !== 0) this.pc = startPC;
      else {
        while (this.token !== RP) {
          this.getToken();
          if (this.token === LBRACE || this.token === SEMI || this.token === LP || this.done) this.error("')' expected");
        }
      }
      startPC = this.pc;
      if (cond === 1) {
        try {
          this.doStatement$s();
        } catch (e) {
          if (!(e instanceof MacroException)) throw e;
          if (e.type === K_BREAK) {
            this.pc = startPC;
            this.skipStatement();
            break;
          }
        }
      } else {
        this.skipStatement();
        break;
      }
      if ((++this.ticks & SYNC_TICK_MASK) === 0) this.syncCheck();
      this.pc = incPC;   // do increment
      do {
        if (this.nextToken() !== RP) { if (fast) this.getAssignmentExpression$s(); else this.getAssignmentExpression$s(); }
        this.getToken();
      } while (this.token === COMMA);
      this.pc = condPC;
    }
    this.looseSyntax = saveLooseSyntax;
    this.loopDepth--;
    if (this.loopDepth === 0) this.inLoop = false;
  },
  doWhile$s() {
    const fast = true;
    this.looseSyntax = false;
    this.loopDepth++;
    this.inLoop = true;
    const savePC = this.pc;
    let isTrue;
    do {
      this.pc = savePC;
      isTrue = fast ? this.getBoolean$s() : this.getBoolean$s();
      if (isTrue) {
        try {
          this.doStatement$s();
        } catch (e) {
          if (!(e instanceof MacroException)) throw e;
          if (e.type === K_BREAK) {
            this.pc = savePC;
            this.getBoolean$s();
            this.skipStatement();
            break;
          }
        }
      } else
        this.skipStatement();
      if ((++this.ticks & SYNC_TICK_MASK) === 0) this.syncCheck();
    } while (isTrue && !this.done);
    this.loopDepth--;
    if (this.loopDepth === 0) this.inLoop = false;
  },
  doDo$s() {
    const fast = true;
    this.looseSyntax = false;
    const savePC = this.pc;
    let isTrue;
    do {
      this.doStatement$s();
      this.getToken();
      if (this.token !== K_WHILE) this.error("'while' expected");
      isTrue = fast ? this.getBoolean$s() : this.getBoolean$s();
      if (isTrue) this.pc = savePC;
      if ((++this.ticks & SYNC_TICK_MASK) === 0) this.syncCheck();
    } while (isTrue && !this.done);
  },
  doBlock$s() {
    this.getToken();
    if (this.token !== LBRACE) this.error("'{' expected");
    while (!this.done) {
      this.getToken();
      if (this.token === RBRACE) break;
      this.putTokenBack();
      this.doStatement$s();
    }
    if (this.token !== RBRACE) this.error("'}' expected");
  },
  runFirstMacro$s() {
    this.getToken();   // skip macro label
    this.doBlock$s();
    this.done = true;
    this.finishUp();
  },
  doAssignment$s() {
    const next = this.pgm.code[this.pc + 1] & 0xff;
    if (next === LSQ) { this.doArrayElementAssignment$s(); return; }
    const type = this.getExpressionType$s();
    switch (type) {
      case V_STRING: this.doStringAssignment$s(); break;
      case V_ARRAY: this.doArrayAssignment$s(); break;
      case USER_FUNCTION: this.doUserFunctionAssignment$s(); break;
      case STRING_FUNCTION: this.doNumericStringAssignment$s(); break;
      default: {
        this.putTokenBack();
        const value = this.getAssignmentExpression$s();
        if (this.evaluating) this.log('' + javaDouble(value));
      }
    }
  },
  getExpressionType$s() {
    const code = this.pgm.code;
    const rightSideToken = code[this.pc + 2];
    const tok = rightSideToken & 0xff;
    if (tok === STRING_CONSTANT) return V_STRING;
    if (tok === STRING_FUNCTION) {
      const address = rightSideToken >> TOK_SHIFT;
      const type = this.pgm.table[address].type;
      if (type === K_DIALOG) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'getNumber' || name === 'getCheckbox') return STRING_FUNCTION;
      } else if (type === K_FILE) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'exists' || name === 'isDirectory' || name === 'length' ||
            name === 'getLength' || name === 'rename' || name === 'delete') return STRING_FUNCTION;
      } else if (type === K_LIST) {
        const token2 = code[this.pc + 4];
        const name = this.pgm.table[token2 >> TOK_SHIFT].str;
        if (name === 'getValue') return STRING_FUNCTION;
      } else if (this.numericStringFunction(this.pc + 2))
        return V_VALUE;
      return V_STRING;
    }
    if (tok === ARRAY_FUNCTION) return V_ARRAY;
    if (tok === USER_FUNCTION) return USER_FUNCTION;
    if (tok === VARIABLE_FUNCTION) {
      if (this.isString(this.pc + 2)) return V_STRING;
      const token2 = code[this.pc + 4];
      const name = this.pgm.table[token2 >> TOK_SHIFT].str;
      if (name === 'getColumn' || name === 'toArray') return V_ARRAY;
    }
    if (tok !== WORD) return V_VALUE;
    const v = this.lookupVariableAt(rightSideToken >> TOK_SHIFT);
    if (v === null) return V_VALUE;
    const type = v.getType();
    if (type === V_VALUE) return V_VALUE;
    else if (type === V_STRING) {
      if (this.isString(this.pc + 2)) return V_STRING;
      return V_VALUE;
    }
    if (code[this.pc + 3] === DOT) return V_VALUE;
    if (code[this.pc + 3] !== LSQ) return V_ARRAY;
    const savePC = this.pc;
    this.getToken();   // "="
    this.getToken();   // the variable
    this.checkingType = true;
    const index = this.getIndex$s();
    this.checkingType = false;
    this.pc = savePC - 1;
    this.getToken();
    const array = v.getArray();
    if (index < 0 || index >= array.length) return V_VALUE;
    return array[index].getType();
  },
  doNumericStringAssignment$s() {
    this.putTokenBack();
    this.getToken();
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) v = this.pushNew(this.tokenAddress, 0.0, null, this);
    this.getToken();
    if (this.token !== EQUALS) this.error("'=' expected");
    v.setValue(this.getExpression$s());
  },
  doArrayElementAssignment$s() {
    const code = this.pgm.code;
    const v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) this.error('Undefined identifier');
    if (code[this.pc + 5] === SEMI && (code[this.pc + 4] === K_PLUS_PLUS || code[this.pc + 4] === K_MINUS_MINUS)) {
      this.putTokenBack();
      this.getFactor$s();
      return;
    }
    const index = this.getIndex$s();
    const expressionType = this.getExpressionType$s();
    if (expressionType === V_ARRAY) this.error('Arrays of arrays not supported');
    this.getToken();
    const op = this.token;
    if (!(op === EQUALS || op === K_PLUS_EQUAL || op === K_MINUS_EQUAL || op === K_MUL_EQUAL || op === K_DIV_EQUAL)) {
      this.error("'=', '+=', '-=', '*=' or '/=' expected");
      return;
    }
    if (op !== EQUALS && (expressionType === V_STRING || expressionType === V_ARRAY)) {
      this.error("'=' expected");
      return;
    }
    let array = v.getArray();
    if (array === null) this.error('Array expected');
    if (index < 0) this.error('Negative index');
    if (index >= array.length) {   // expand array
      if (!this.func.expandableArrays) this.error('Index (' + index + ') out of range');
      const len2 = index + Math.floor(array.length / 2) + 1;
      checkArraySize(this, len2);
      const array2 = new Array(len2);
      const strings = array.length > 0 && array[0].getString() !== null;
      for (let i = 0; i < len2; i++) {
        if (i < array.length) array2[i] = array[i];
        else {
          array2[i] = Variable.num(NaN);
          if (strings) array2[i].setString('undefined');
        }
      }
      v.setArray(array2);
      v.setArraySize(index + 1);
      array = v.getArray();
    }
    const size = v.getArraySize();
    if (index + 1 > size) v.setArraySize(index + 1);
    switch (expressionType) {
      case V_STRING:
        array[index].setString(this.getString$s());
        break;
      case V_ARRAY:
        this.getToken();
        if (this.token === ARRAY_FUNCTION)
          array[index].setArray(this.func.getArrayFunction$s(this.pgm.table[this.tokenAddress].type));
        break;
      case USER_FUNCTION: {
        const savePC = this.pc;
        this.getToken();   // the function
        const simpleFunctionCall = this.isSimpleFunctionCall(true);
        this.pc = savePC;
        if (simpleFunctionCall) {
          this.getToken();   // the function
          const v2 = this.runUserFunction$s();
          if (v2 === null) this.error('No return value');
          if (this.done) return;
          const type = v2.getType();
          if (type === V_VALUE) array[index].setValue(v2.getValue());
          else array[index].setString(v2.getString());
        } else
          array[index].setValue(this.getExpression$s());
        break;
      }
      default:
        switch (op) {
          case EQUALS: array[index].setValue(this.getExpression$s()); break;
          case K_PLUS_EQUAL: array[index].setValue(array[index].getValue() + (this.getExpression$s())); break;
          case K_MINUS_EQUAL: array[index].setValue(array[index].getValue() - (this.getExpression$s())); break;
          case K_MUL_EQUAL: array[index].setValue(array[index].getValue() * (this.getExpression$s())); break;
          case K_DIV_EQUAL: array[index].setValue(array[index].getValue() / (this.getExpression$s())); break;
          default:
        }
    }
  },
  doUserFunctionAssignment$s() {
    this.putTokenBack();
    const savePC = this.pc;
    this.getToken();   // the variable
    this.getToken();   // '='
    this.getToken();   // the function
    const simpleAssignment = this.isSimpleFunctionCall(true);
    this.pc = savePC;
    if (!simpleAssignment) this.getAssignmentExpression$s();
    else {
      this.getToken();
      let v1 = this.lookupLocalVariable(this.tokenAddress);
      if (v1 === null) v1 = this.pushNew(this.tokenAddress, 0.0, null, this);
      this.getToken();
      if (this.token !== EQUALS) this.error("'=' expected");
      this.getToken();   // the function
      const v2 = this.runUserFunction$s();
      if (v2 === null) this.error('No return value');
      if (this.done) return;
      const type = v2.getType();
      if (type === V_VALUE) v1.setValue(v2.getValue());
      else if (type === V_ARRAY) { v1.setArray(v2.getArray()); v1.setArraySize(v2.getArraySize()); }
      else v1.setString(v2.getString());
    }
  },
  doStringAssignment$s() {
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) {
      if (this.nextToken() === EQUALS) v = this.pushNew(this.tokenAddress, 0.0, null, this);
      else this.error('Undefined identifier');
    }
    this.getToken();
    if (this.token === EQUALS) v.setString(this.getString$s());
    else if (this.token === K_PLUS_EQUAL) v.setString(v.getString() + (this.getString$s()));
    else this.error("'=' or '+=' expected");
  },
  doArrayAssignment$s() {
    let v = this.lookupLocalVariable(this.tokenAddress);
    if (v === null) {
      if (this.nextToken() === EQUALS) v = this.pushNew(this.tokenAddress, 0.0, null, this);
      else this.error('Undefined identifier');
    }
    this.getToken();
    if (this.token !== EQUALS) { this.error("'=' expected"); return; }
    this.getToken();
    if (this.token === ARRAY_FUNCTION)
      v.setArray(this.func.getArrayFunction$s(this.pgm.table[this.tokenAddress].type));
    else if (this.token === WORD) {
      const v2 = this.lookupVariable();
      v.setArray(v2.getArray());
      v.setArraySize(v2.getArraySize());
    } else if (this.token === VARIABLE_FUNCTION) {
      const v2 = this.func.getVariableFunction$s(this.pgm.table[this.tokenAddress].type);
      const array = v2.getArray();
      if (array === null) this.error('Array expected');
      v.setArray(array);
    } else
      this.error('Array expected');
  },
  doIf$s() {
    const fast = true;
    this.looseSyntax = false;
    const b = fast ? this.getBoolean$s() : this.getBoolean$s();
    if (b) {
      this.doStatement$s();
    } else this.skipStatement();
    let next = this.nextToken();
    if (next === SEMI) {
      this.getToken();
      next = this.nextToken();
    }
    if (next === K_ELSE) {
      this.getToken();
      if (b) this.skipStatement();
      else {
        this.doStatement$s();
      }
    }
  },
  getBoolean$s() {
    this.getLeftParen();
    const value = this.getLogicalExpression$s();
    this.checkBoolean(value);
    this.getRightParen();
    return value === 0.0 ? false : true;
  },
  getLogicalExpression$s() {
    const v1 = this.getBooleanExpression$s();
    const next = this.nextToken();
    if (!(next === K_LOGICAL_AND || next === K_LOGICAL_OR)) return v1;
    this.checkBoolean(v1);
    this.getToken();
    const op = this.token;
    const v2 = this.getLogicalExpression$s();
    this.checkBoolean(v2);
    if (op === K_LOGICAL_AND) return toInt(v1) & toInt(v2);
    else if (op === K_LOGICAL_OR) return toInt(v1) | toInt(v2);
    return v1;
  },
  getBooleanExpression$s() {
    let v1 = 0.0, s1 = null;
    let next = this.pgm.code[this.pc + 1];
    const tok = next & TOK_MASK;
    if (tok === STRING_CONSTANT || tok === STRING_FUNCTION || this.isString(this.pc + 1)) {
      if (this.numericStringFunction(this.pc + 1)) v1 = this.getExpression$s();
      else s1 = this.getString$s();
    } else
      v1 = this.getExpression$s();
    next = this.nextToken();
    if (next >= K_EQ && next <= K_LTE) {
      this.getToken();
      const op = this.token;
      if (s1 !== null) return this.compareStrings(s1, this.getString$s(), op);
      const v2 = this.getExpression$s();
      switch (op) {
        case K_EQ: v1 = v1 === v2 ? 1.0 : 0.0; break;
        case K_NEQ: v1 = v1 !== v2 ? 1.0 : 0.0; break;
        case K_GT: v1 = v1 > v2 ? 1.0 : 0.0; break;
        case K_GTE: v1 = v1 >= v2 ? 1.0 : 0.0; break;
        case K_LT: v1 = v1 < v2 ? 1.0 : 0.0; break;
        case K_LTE: v1 = v1 <= v2 ? 1.0 : 0.0; break;
        default:
      }
    } else if (s1 !== null) {
      if (s1 === 'true') v1 = 1.0;
      else if (s1 === 'false') v1 = 0.0;
      else v1 = toolsParseDouble(s1, NaN);
    }
    return v1;
  },
  getAssignmentExpression$s() {
    const code = this.pgm.code;
    const tokPlus2 = code[this.pc + 2];
    if ((code[this.pc + 1] & 0xff) === WORD && (tokPlus2 === EQUALS || tokPlus2 === K_PLUS_EQUAL ||
        tokPlus2 === K_MINUS_EQUAL || tokPlus2 === K_MUL_EQUAL || tokPlus2 === K_DIV_EQUAL)) {
      this.getToken();
      let v = this.lookupLocalVariable(this.tokenAddress);
      const saveAddress = this.tokenAddress;
      this.getToken();
      let value = 0.0;
      if (this.token === EQUALS) value = this.getAssignmentExpression$s();
      else {
        value = v !== null ? v.getValue() : 0.0;
        switch (this.token) {
          case K_PLUS_EQUAL: value += this.getAssignmentExpression$s(); break;
          case K_MINUS_EQUAL: value -= this.getAssignmentExpression$s(); break;
          case K_MUL_EQUAL: value *= this.getAssignmentExpression$s(); break;
          case K_DIV_EQUAL: value /= this.getAssignmentExpression$s(); break;
          default:
        }
      }
      if (v === null) v = this.pushNew(saveAddress, 0.0, null, this);
      v.setValue(value);
      return value;
    }
    return this.getLogicalExpression$s();
  },
  doVar$s() {
    this.getToken();
    while (this.token === WORD) {
      if (this.nextToken() === EQUALS) this.doAssignment$s();
      else {
        const v = this.lookupVariableAt(this.tokenAddress);
        if (v === null) this.pushNew(this.tokenAddress, 0.0, null, this);
      }
      this.getToken();
      if (this.token === COMMA) this.getToken();
      else { this.putTokenBack(); break; }
    }
  },
  getString$s() {
    let str = this.getStringTerm$s();
    for (;;) {
      this.getToken();
      if (this.token === C('+')) str += this.getStringTerm$s();
      else { this.putTokenBack(); break; }
    }
    return str;
  },
  getStringTerm$s() {
    let str, v;
    this.getToken();
    switch (this.token) {
      case STRING_CONSTANT:
        str = this.tokenString;
        break;
      case STRING_FUNCTION:
        str = this.func.getStringFunction$s(this.pgm.table[this.tokenAddress].type);
        break;
      case VARIABLE_FUNCTION:
        if (!this.isString(this.pc)) {
          this.putTokenBack();
          str = this.numToString(this.getStringExpression$s());
          break;
        }
        v = this.func.getVariableFunction$s(this.pgm.table[this.tokenAddress].type);
        str = v.getString();
        if (str === null) {
          const value = v.getValue();
          str = toInt(value) === value ? d2s(value, 0) : javaDouble(value);
        }
        break;
      case USER_FUNCTION:
        v = this.runUserFunction$s();
        if (v === null) this.error('No return value');
        str = v.getString();
        if (str === null) {
          const value = v.getValue();
          str = toInt(value) === value ? d2s(value, 0) : javaDouble(value);
        }
        break;
      case WORD:
        str = this.lookupStringVariable$s();
        if (str !== null) break;
        // falls through
      default:
        this.putTokenBack();
        str = this.numToString(this.getStringExpression$s());
    }
    return str;
  },
  getExpression$s() {
    let value = this.getTerm$s();
    for (;;) {
      const next = this.nextToken();
      if (next === 43) { this.getToken(); value += this.getTerm$s(); }
      else if (next === 45) { this.getToken(); value -= this.getTerm$s(); }
      else break;
    }
    return value;
  },
  getTerm$s() {
    let value = this.getFactor$s();
    for (;;) {
      const next = this.nextToken();
      switch (next) {
        case 42: this.getToken(); value *= this.getFactor$s(); break;
        case 47: this.getToken(); value /= this.getFactor$s(); break;
        case 37: this.getToken(); value %= this.getFactor$s(); break;
        case 38: this.getToken(); value = toInt(value) & toInt(this.getFactor$s()); break;
        case 124: this.getToken(); value = toInt(value) | toInt(this.getFactor$s()); break;
        case 94: this.getToken(); value = toInt(value) ^ toInt(this.getFactor$s()); break;
        case K_SHIFT_RIGHT: this.getToken(); value = toInt(value) >> toInt(this.getFactor$s()); break;
        case K_SHIFT_LEFT: this.getToken(); value = toInt(value) << toInt(this.getFactor$s()); break;
        default: return value;
      }
    }
  },
  getFactor$s() {
    let value = 0.0, v = null;
    this.getToken();
    switch (this.token) {
      case NUMBER:
        value = this.tokenValue;
        break;
      case STRING_CONSTANT:
        value = toolsParseDouble(this.tokenString, NaN);
        break;
      case NUMERIC_FUNCTION:
        value = this.func.getFunctionValue$s(this.pgm.table[this.tokenAddress].type);
        break;
      case STRING_FUNCTION: {
        const str = this.func.getStringFunction$s(this.pgm.table[this.tokenAddress].type);
        if (this.nextToken() === DOT) {
          this.getToken();   // '.'
          this.getToken();   // numericFunction
          value = this.getNumericStringFunction$s(str);
        } else
          value = toolsParseDouble(str, NaN);
        if ('NaN' === str) value = NaN;
        else if (value !== value) this.error('Numeric value expected');
        break;
      }
      case VARIABLE_FUNCTION:
        v = this.func.getVariableFunction$s(this.pgm.table[this.tokenAddress].type);
        if (v === null) this.error('No return value');
        if (v.getString() !== null) this.error('Numeric return value expected');
        else value = v.getValue();
        break;
      case USER_FUNCTION:
        v = this.runUserFunction$s();
        if (v === null) this.error('No return value');
        if (this.done) value = 0;
        else {
          if (v.getString() !== null) this.error('Numeric return value expected');
          else value = v.getValue();
        }
        break;
      case K_TRUE: value = 1.0; break;
      case K_FALSE: value = 0.0; break;
      case K_PI: value = Math.PI; break;
      case K_NaN: value = NaN; break;
      case WORD: {
        v = this.lookupVariable();
        if (v === null) return 0.0;
        let next = this.nextToken();
        if (next === LSQ) {
          v = this.getArrayElement$s(v);
          value = v.getValue();
          next = this.nextToken();
          if (next === DOT) {
            value = this.runNumericFunction$s(v);
            next = this.nextToken();
          }
        } else if (next === DOT) {
          value = this.runNumericFunction$s(v);
          next = this.nextToken();
        } else {
          if (v.getArray() !== null) {
            this.getToken();
            this.error("'[' or '.' expected");
          }
          if (this.prefixValue !== 0 && !this.checkingType) {
            v.setValue(v.getValue() + this.prefixValue);
            this.prefixValue = 0;
          }
          value = v.getValue();
        }
        if (!(next === K_PLUS_PLUS || next === K_MINUS_MINUS)) break;
        this.getToken();
        if (this.token === K_PLUS_PLUS) v.setValue(v.getValue() + (this.checkingType ? 0 : 1));
        else v.setValue(v.getValue() - (this.checkingType ? 0 : 1));
        break;
      }
      case LP:
        value = this.getLogicalExpression$s();
        this.getRightParen();
        break;
      case K_PLUS_PLUS:
        this.prefixValue = 1;
        value = this.getFactor$s();
        break;
      case K_MINUS_MINUS:
        this.prefixValue = -1;
        value = this.getFactor$s();
        break;
      case 33:
        value = this.getFactor$s();
        if (value === 0.0 || value === 1.0) value = value === 0.0 ? 1.0 : 0.0;
        else this.error('Boolean expected');
        break;
      case 45:
        value = -(this.getFactor$s());
        break;
      case 126:
        value = ~toInt(this.getFactor$s());
        break;
      default:
        this.error('Number or numeric function expected');
    }
    return value;
  },
  getNumericStringFunction$s(str) {
    let value = NaN;
    if (this.token === WORD) {
      if (this.tokenString === 'length') { this.getParens(); value = str.length; }
      else if (this.tokenString === 'contains') value = str.indexOf(this.func.getStringArg$s()) >= 0 ? 1 : 0;
      else if (this.tokenString === 'charAt') {
        const i = toInt(this.func.getArg$s());
        if (i < 0 || i >= str.length) throw new JavaException('java.lang.StringIndexOutOfBoundsException: index ' + i + ', length ' + str.length);
        value = str.charCodeAt(i);
      }
    } else if (this.token === NUMERIC_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_INDEX_OF: value = this.func.indexOf$s(str); break;
        case K_LAST_INDEX_OF: value = str.lastIndexOf(this.func.getStringArg$s()); break;
        case K_STARTS_WITH: value = str.startsWith(this.func.getStringArg$s()) ? 1 : 0; break;
        case K_ENDS_WITH: value = str.endsWith(this.func.getStringArg$s()) ? 1 : 0; break;
        case K_MATCHES: value = this.func.matches$s(str); break;
        default:
      }
    } else
      this.error('Numeric function expected');
    return value;
  },
  getArrayElement$s(v) {
    const index = this.getIndex$s();
    const array = v.getArray();
    if (array === null) this.error('Array expected');
    if (index < 0 || index >= array.length) {
      if (array.length === 0) this.error('Empty array');
      else this.error('Index (' + index + ') out of 0-' + (array.length - 1) + ' range');
    }
    return array[index];
  },
  runNumericFunction$s(v) {
    this.getToken();   // '.'
    this.getToken();
    if (this.token === WORD && v.getArray() !== null && this.tokenString === 'length') return v.getArraySize();
    const str = v.getString();
    if (str === null) this.error('Array or string expected');
    return this.getNumericStringFunction$s(str);
  },
  getStringExpression$s() {
    let value = this.getTerm$s();
    for (;;) {
      this.getToken();
      if (this.token === 43) {
        this.getToken();
        if (this.token === STRING_CONSTANT || this.token === STRING_FUNCTION) {
          this.putTokenBack();
          this.putTokenBack();
          break;
        }
        if (this.token === WORD) {
          const v = this.lookupVariableAt(this.tokenAddress);
          if (v !== null && v.getString() !== null) {
            this.putTokenBack();
            this.putTokenBack();
            break;
          }
        }
        this.putTokenBack();
        value += this.getTerm$s();
      } else if (this.token === 45)
        value -= this.getTerm$s();
      else {
        this.putTokenBack();
        break;
      }
    }
    return value;
  },
  lookupStringVariable$s() {
    if (this.stack === null) { this.undefined_(); return ''; }
    let found = false, str = null;
    for (let i = this.topOfStack; i >= 0; i--) {
      if (this.stack[i].symTabIndex === this.tokenAddress) {
        const v = this.stack[i];
        found = true;
        const next = this.nextToken();
        if (next === LSQ) {
          const savePC = this.pc;
          const index = this.getIndex$s();
          const array = v.getArray();
          if (array === null) this.error('Array expected');
          if (index < 0 || index >= array.length) this.error('Index (' + index + ') out of 0-' + (array.length - 1) + ' range');
          str = array[index].getString();
          const next2 = this.nextToken();
          if (str !== null) {
            if (next2 === DOT) str = this.runStringFunction$s(str);
          } else {
            if (next2 === RP || next2 === SEMI) str = this.numToString(array[index].getValue());
            else {
              this.pc = savePC - 1;
              this.getToken();
            }
          }
        } else if (next === DOT) {
          if (v.getString() !== null) str = this.runStringFunction$s(v.getString());
        } else {
          if (v.getArray() !== null) { this.getToken(); this.error("'[' or '.' expected"); }
          str = v.getString();
        }
        break;
      }
    }
    if (!found) this.undefined_();
    return str;
  },
  runStringFunction$s(str) {
    this.getToken();   // '.'
    this.getToken();
    if (this.token === WORD) {
      if (this.tokenString === 'length') { this.getParens(); str = '' + str.length; }
      else if (this.tokenString === 'contains') str = '' + (str.indexOf(this.func.getStringArg$s()) >= 0);
      else if (this.tokenString === 'replaceAll') str = this.func.replace$s(str);
      else str = null;
    } else if (this.token === NUMERIC_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_INDEX_OF: str = '' + (this.func.indexOf$s(str)); break;
        case K_LAST_INDEX_OF: str = '' + str.lastIndexOf(this.func.getStringArg$s()); break;
        case K_STARTS_WITH: str = '' + str.startsWith(this.func.getStringArg$s()); break;
        case K_ENDS_WITH: str = '' + str.endsWith(this.func.getStringArg$s()); break;
        case K_MATCHES: str = javaDouble(this.func.matches$s(str)); break;
        default: str = null;
      }
    } else if (this.token === STRING_FUNCTION) {
      const type = this.pgm.table[this.tokenAddress].type;
      switch (type) {
        case K_SUBSTRING: str = this.func.substring$s(str); break;
        case K_TO_LOWER_CASE: this.getParens(); str = str.toLowerCase(); break;
        case K_TO_UPPER_CASE: this.getParens(); str = str.toUpperCase(); break;
        case K_REPLACE: str = this.func.replace$s(str); break;
        case K_TRIM: this.getParens(); str = javaTrim(str); break;
        case K_CHARAT: {
          const index = toInt(this.func.getArg$s());
          this.func.checkIndex(index, 0, str.length - 1);
          str = str.charAt(index);
          break;
        }
        default: str = null;
      }
    } else
      str = null;
    if (str === null) this.error('String function expected');
    return str;
  },
  getIndex$s() {
    this.getToken();
    if (this.token !== LSQ) this.error("'['expected");
    const index = toInt(this.getExpression$s());
    this.getToken();
    if (this.token !== RSQ) this.error("']' expected");
    return index;
  },
});
Object.assign(Functions.prototype, {
  doFunction$s(type) {
    const fn = BUILTINS_S.do.get(type);
    if (fn === undefined) { this.notAvailable(type, 'do'); return; }
    const r = fn(this);
    syncResult(r);
  },
  getFunctionValue$s(type) {
    const fn = BUILTINS_S.num.get(type);
    if (fn === undefined) return this.notAvailable(type, 'num');
    const r = fn(this);
    return syncResult(r);
  },
  getStringFunction$s(type) {
    const fn = BUILTINS_S.str.get(type);
    if (fn === undefined) return this.notAvailable(type, 'str');
    const r = fn(this);
    return syncResult(r);
  },
  getArrayFunction$s(type) {
    const fn = BUILTINS_S.arr.get(type);
    if (fn === undefined) return this.notAvailable(type, 'arr');
    const r = fn(this);
    return syncResult(r);
  },
  getVariableFunction$s(type) {
    const fn = BUILTINS_S.variable.get(type);
    if (fn === undefined) { this.notAvailable(type, 'variable'); return Variable.num(NaN); }
    const r = fn(this);
    let v = syncResult(r);
    if (v === null || v === undefined) v = Variable.num(NaN);
    return v;
  },
  hostCall$s(name, args) {
    const host = this.interp.ctx.host;
    if (!host || typeof host.call !== 'function') {
      this.interp.error('Function not available in the browser: ' + name);
      return null;
    }
    const v = this.hostHook$s(() => host.call(name, args || [], this.interp.ctx));
    return v === undefined ? null : v;
  },
  hostHook$s(fn) {
    try {
      let v = fn();
      if (isThenable(v)) v = (syncAwait(v));
      return v;
    } catch (e) {
      if (e instanceof MacroCancel || e instanceof SyncViolation) throw e;
      this.interp.error(String(e && e.message !== undefined ? e.message : e));
      return undefined;
    }
  },
  showMessage$s(title, text) { this.hostHook$s(() => this.interp.ctx.showMessage(title, text)); },
  getArg$s() {
    const it = this.interp;
    it.getLeftParen();
    const arg = it.getExpression$s();
    it.getRightParen();
    return arg;
  },
  getFirstArg$s() { this.interp.getLeftParen(); return this.interp.getExpression$s(); },
  getNextArg$s() { this.interp.getComma(); return this.interp.getExpression$s(); },
  getLastArg$s() {
    this.interp.getComma();
    const arg = this.interp.getExpression$s();
    this.interp.getRightParen();
    return arg;
  },
  getString$s() {
    let str = this.interp.getStringTerm$s();
    for (;;) {
      this.interp.getToken();
      if (this.interp.token === 43) str += this.interp.getStringTerm$s();
      else { this.interp.putTokenBack(); break; }
    }
    return str;
  },
  getStringArg$s() {
    this.interp.getLeftParen();
    const arg = this.getString$s();
    this.interp.getRightParen();
    return arg;
  },
  getFirstString$s() { this.interp.getLeftParen(); return this.getString$s(); },
  getNextString$s() { this.interp.getComma(); return this.getString$s(); },
  getLastString$s() {
    this.interp.getComma();
    const arg = this.getString$s();
    this.interp.getRightParen();
    return arg;
  },
  getBooleanArg$s() {
    const it = this.interp;
    it.getLeftParen();
    const arg = it.getBooleanExpression$s();
    it.checkBoolean(arg);
    it.getRightParen();
    return arg === 0 ? false : true;
  },
  getVariable$s() {
    const it = this.interp;
    it.getToken();
    if (it.token !== WORD) it.error('Variable expected');
    let v = it.lookupLocalVariable(it.tokenAddress);
    if (v === null) v = it.pushNew(it.tokenAddress, 0.0, null, it);
    const array = v.getArray();
    if (array !== null) {
      const index = it.getIndex$s();
      this.checkIndex(index, 0, v.getArraySize() - 1);
      v = array[index];
    }
    return v;
  },
  getFirstVariable$s() { this.interp.getLeftParen(); return this.getVariable$s(); },
  getNextVariable$s() { this.interp.getComma(); return this.getVariable$s(); },
  getLastVariable$s() {
    this.interp.getComma();
    const v = this.getVariable$s();
    this.interp.getRightParen();
    return v;
  },
  getArray$s() {
    const it = this.interp;
    it.getToken();
    const newArray = it.token === ARRAY_FUNCTION && this.pgm.table[it.tokenAddress].type === K_NEW_ARRAY;
    const arrayFunction = it.token === ARRAY_FUNCTION;
    if (!(it.token === WORD || newArray || arrayFunction)) it.error('Array expected');
    let a = null;
    if (newArray) a = this.getArrayFunction$s(K_NEW_ARRAY);
    else if (arrayFunction) a = this.getArrayFunction$s(this.pgm.table[it.tokenAddress].type);
    else {
      const v = it.lookupVariable();
      a = v.getArray();
      const size = v.getArraySize();
      if (a !== null && a.length !== size) {
        v.setArray(a.slice(0, size));
        a = v.getArray();
      }
    }
    if (a === null) it.error('Array expected');
    return a;
  },
  getNumericArray$s() { return (this.getArray$s()).map((v) => v.getValue()); },
  getFirstArray$s() { this.interp.getLeftParen(); return this.getNumericArray$s(); },
  getNextArray$s() { this.interp.getComma(); return this.getNumericArray$s(); },
  getLastArray$s() {
    this.interp.getComma();
    const a = this.getNumericArray$s();
    this.interp.getRightParen();
    return a;
  },
  getStringFunctionArg$s(s) {
    if (s === null) {
      s = this.getFirstString$s();
      this.interp.getComma();
    } else
      this.interp.getLeftParen();
    return s;
  },
  substring$s(s) {
    const it = this.interp;
    s = this.getStringFunctionArg$s(s);
    const index1 = toInt(it.getExpression$s());
    let index2 = s.length;
    if (it.nextToken() === COMMA) index2 = toInt(this.getLastArg$s());
    else it.getRightParen();
    if (index1 > index2) it.error('beginIndex>endIndex');
    this.checkIndex(index1, 0, s.length);
    this.checkIndex(index2, 0, s.length);
    return s.substring(index1, index2);
  },
  indexOf$s(s1) {
    const it = this.interp;
    s1 = this.getStringFunctionArg$s(s1);
    const s2 = this.getString$s();
    let fromIndex = 0;
    if (it.nextToken() === COMMA) {
      fromIndex = toInt(this.getLastArg$s());
      this.checkIndex(fromIndex, 0, s1.length - 1);
    } else
      it.getRightParen();
    return fromIndex === 0 ? s1.indexOf(s2) : s1.indexOf(s2, fromIndex);
  },
  replace$s(s1) {
    s1 = this.getStringFunctionArg$s(s1);
    const s2 = this.getString$s();
    const s3 = this.getLastString$s();
    if (s2.length === 1) {
      let sb = '';
      for (let i = 0; i < s1.length; i++) {
        const c = s1.charAt(i);
        sb += c === s2.charAt(0) ? s3 : c;
      }
      return sb;
    }
    try {
      return javaReplaceAll(s1, s2, s3);
    } catch (e) {
      if (isInternalFault(e)) throw e;
      this.interp.error('' + (e && e.javaMessage ? e.javaMessage : e));
      return null;
    }
  },
  getStringArray$s() {
    return (this.getArray$s()).map((v) => {
      const s = v.getString();
      return s === null ? javaDouble(v.getValue()) : s;
    });
  },
  matches$s(str) {
    str = this.getStringFunctionArg$s(str);
    const regex = this.getString$s();
    this.interp.getRightParen();
    try {
      return javaRegex(regex, true).test(str) ? 1.0 : 0.0;
    } catch (e) {
      if (isInternalFault(e)) throw e;
      this.interp.error('' + (e && e.javaMessage ? e.javaMessage : e));
      return 0.0;
    }
  },
});
function printFn$s(f) {
  const it = f.interp;
  it.inPrint = true;
  let s = f.getFirstString$s();
  if (it.nextToken() === COMMA) {
    if (s.startsWith('[') && s.endsWith(']')) {
      const title = s.substring(1, s.length - 1);
      const s2 = f.getLastString$s();
      const host = it.ctx.host;
      if (host && typeof host.printToWindow === 'function') f.hostHook$s(() => host.printToWindow(title, s2));
      else it.error('Window not found');
      return;
    } else if (s === '~0~') {
      if (f.writer === null) it.error('File not open');
      const s2 = f.getLastString$s();
      const w = f.writer;
      f.hostHook$s(() => w.print(s2.endsWith('\n') ? s2 : s2 + '\n'));
      it.inPrint = false;
      return;
    }
    let sb = s;
    do {
      sb += ' ' + (f.getNextString$s());
    } while (it.nextToken() === COMMA);
    s = sb;
  }
  it.getRightParen();
  it.log(s);
  it.inPrint = false;
}
defineS('do', K_PRINT, printFn$s, { suspends: printSuspends });
defineS('do', K_WRITE, printFn$s, { suspends: printSuspends });
defineS('do', K_DUMP, (f) => { f.interp.dump(); });
function hostVersion$s(f, host) {
  if (host && typeof host.getVersion === 'function') {
    const v = f.hostHook$s(() => host.getVersion());
    if (v !== undefined && v !== null) return '' + v;
  }
  return IMAGEJ_VERSION;
}
defineS('do', K_REQUIRES, function (f) {
  const version = f.getStringArg$s();
  const host = f.interp.ctx.host;
  const current = hostVersion$s(f, host);
  if (compareTo(current, version) < 0) {
    f.showMessage$s('ImageJ', 'This plugin or macro requires ImageJ ' + version + ' or later. Use\nHelp>Update ImageJ to upgrade to the latest version.');
    f.interp.done = true;
  }
}, { suspends: true });
defineS('do', K_EXIT, function (f) {
  const it = f.interp;
  let msg = null;
  if (it.nextToken() === LP) {
    it.getLeftParen();
    if (it.nextToken() !== RP) msg = f.getString$s();
    it.getRightParen();
  }
  it.finishUp();
  if (msg !== null) f.showMessage$s('Macro', msg);
  throw new MacroCancel('exit');
}, { suspends: exitSuspends });
function mathFn$s(f, type) {
  const arg = f.getArg$s();
  switch (type) {
    case K_ABS: return Math.abs(arg);
    case K_COS: return Math.cos(arg);
    case K_EXP: return Math.exp(arg);
    case K_FLOOR: return Math.floor(arg);
    case K_LOG: return Math.log(arg);
    case K_ROUND: return Math.floor(arg + 0.5);
    case K_SIN: return Math.sin(arg);
    case K_SQRT: return Math.sqrt(arg);
    case K_TAN: return Math.tan(arg);
    case K_ATAN: return Math.atan(arg);
    case K_ASIN: return Math.asin(arg);
    case K_ACOS: return Math.acos(arg);
    default: return 0.0;
  }
}
for (const id of [K_ABS, K_COS, K_EXP, K_FLOOR, K_LOG, K_ROUND, K_SIN, K_SQRT, K_TAN, K_ATAN, K_ASIN, K_ACOS])
  defineS('num', id, (f) => mathFn$s(f, id));
function math2Fn$s(f, type) {
  const a1 = f.getFirstArg$s();
  const a2 = f.getLastArg$s();
  switch (type) {
    case K_MIN_OF: return javaMin(a1, a2);
    case K_MAX_OF: return javaMax(a1, a2);
    case K_POW: return javaPow(a1, a2);
    case K_ATAN2: return Math.atan2(a1, a2);
    default: return 0.0;
  }
}
for (const id of [K_MAX_OF, K_MIN_OF, K_POW, K_ATAN2]) defineS('num', id, (f) => math2Fn$s(f, id));
defineS('num', K_MATH, function (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  if (name === 'min') return javaMin(f.getFirstArg$s(), f.getLastArg$s());
  if (name === 'max') return javaMax(f.getFirstArg$s(), f.getLastArg$s());
  if (name === 'pow') return javaPow(f.getFirstArg$s(), f.getLastArg$s());
  if (name === 'atan2') return Math.atan2(f.getFirstArg$s(), f.getLastArg$s());
  if (name === 'constrain') {
    const a = f.getFirstArg$s(), b = f.getNextArg$s(), c = f.getLastArg$s();
    return javaMin(javaMax(a, b), c);
  }
  if (name === 'map') {
    const value = f.getFirstArg$s();
    const fromLow = f.getNextArg$s();
    const fromHigh = f.getNextArg$s();
    const toLow = f.getNextArg$s();
    const toHigh = f.getLastArg$s();
    return (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow) + toLow;
  }
  const arg = f.getArg$s();
  switch (name) {
    case 'ceil': return Math.ceil(arg);
    case 'abs': return Math.abs(arg);
    case 'cos': return Math.cos(arg);
    case 'exp': return Math.exp(arg);
    case 'floor': return Math.floor(arg);
    case 'log': return Math.log(arg);
    case 'log10': return log10Java(arg);
    case 'round': return javaRound(arg);
    case 'sin': return Math.sin(arg);
    case 'sqr': return arg * arg;
    case 'sqrt': return Math.sqrt(arg);
    case 'tan': return Math.tan(arg);
    case 'atan': return Math.atan(arg);
    case 'asin': return Math.asin(arg);
    case 'acos': return Math.acos(arg);
    case 'erf': return erf(arg);
    case 'toRadians': return arg * 0.017453292519943295;
    case 'toDegrees': return arg * 57.29577951308232;
    default:
      it.error('Unrecognized function name');
      return NaN;
  }
});
defineS('num', K_IS_NAN, function (f) { const v = f.getArg$s(); return v !== v ? 1 : 0; });
defineS('num', K_GET_TIME, (f) => { f.interp.getParens(); return Date.now(); });
defineS('num', K_PARSE_FLOAT, function (f) { return parseDoubleFn(f.getStringArg$s()); });
defineS('num', K_PARSE_INT, function (f) {
  const it = f.interp;
  const s = f.getFirstString$s();
  let radix = 10;
  if (it.nextToken() === COMMA) {
    it.getComma();
    radix = toInt(it.getExpression$s());
    if (radix < 2 || radix > 36) radix = 10;
  }
  it.getRightParen();
  let n;
  if (radix === 10) {
    n = parseDoubleFn(s);
    if (n === n) n = javaRound(n);
  } else {
    // Integer.parseInt(s, radix): optional sign, digits of the radix, fits an int
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
    const m = /^([+-]?)(.+)$/.exec(s);
    n = NaN;
    if (m && [...m[2].toLowerCase()].every((c) => digits.indexOf(c) >= 0)) {
      let v = 0n;
      for (const c of m[2].toLowerCase()) v = v * BigInt(radix) + BigInt(digits.indexOf(c));
      if (m[1] === '-') v = -v;
      if (v >= -2147483648n && v <= 2147483647n) n = Number(v);
    }
  }
  return n;
});
defineS('num', K_LENGTH_OF, function (f) {
  const it = f.interp, code = f.pgm.code;
  let length = 0;
  it.getLeftParen();
  switch (it.nextToken()) {
    case STRING_CONSTANT: case STRING_FUNCTION: case USER_FUNCTION:
      length = (f.getString$s()).length;
      break;
    case WORD: {
      if (code[it.pc + 2] === LSQ) { length = (f.getString$s()).length; break; }
      it.getToken();
      const v = it.lookupVariable();
      if (v === null) return 0.0;
      const s = v.getString();
      if (s !== null) length = s.length;
      else {
        const array = v.getArray();
        if (array !== null) length = v.getArraySize();
        else it.error('String or array expected');
      }
      break;
    }
    default:
      it.error('String or array expected');
  }
  it.getRightParen();
  return length;
});
defineS('num', K_INDEX_OF, (f) => f.indexOf$s(null));
defineS('num', K_LAST_INDEX_OF, function (f) { return (f.getFirstString$s()).lastIndexOf(f.getLastString$s()); });
defineS('num', K_STARTS_WITH, function (f) { const a = f.getFirstString$s(); return a.startsWith(f.getLastString$s()) ? 1 : 0; });
defineS('num', K_ENDS_WITH, function (f) { const a = f.getFirstString$s(); return a.endsWith(f.getLastString$s()) ? 1 : 0; });
defineS('num', K_MATCHES, (f) => f.matches$s(null));
defineS('num', K_CHAR_CODE_AT, function (f) {
  const str = f.getFirstString$s();
  const index = toInt(f.getLastArg$s());
  f.checkIndex(index, 0, str.length - 1);
  return str.charCodeAt(index);
});
defineS('str', K_D2S, function (f) {
  const x = f.getFirstArg$s();
  return d2s(x, toInt(f.getLastArg$s()));
});
defineS('str', K_TO_HEX, function (f) { return (toInt(f.getArg$s()) >>> 0).toString(16); });
defineS('str', K_TO_BINARY, function (f) { return (toInt(f.getArg$s()) >>> 0).toString(2); });
defineS('str', K_SUBSTRING, (f) => f.substring$s(null));
defineS('str', K_REPLACE, (f) => f.replace$s(null));
defineS('str', K_TO_LOWER_CASE, function (f) { return (f.getStringArg$s()).toLowerCase(); });
defineS('str', K_TO_UPPER_CASE, function (f) { return (f.getStringArg$s()).toUpperCase(); });
defineS('str', K_TRIM, function (f) {
  if (f.interp.nextToken() === EQUALS) f.interp.error("'trim' is a reserved word");
  return javaTrim(f.getStringArg$s());
});
defineS('str', K_FROM_CHAR_CODE, function (f) {
  const it = f.interp;
  let s = '', count = 0;
  it.getLeftParen();
  while (it.nextToken() !== RP) {
    const value = toInt(it.getExpression$s());
    if (value < 0 || value > 65535) it.error('Value (' + value + ') out of 0-65535 range');
    if (count === 100) throw new JavaException('java.lang.ArrayIndexOutOfBoundsException: Index 100 out of bounds for length 100');   // Functions.fromCharCode: char[100]
    count++;
    s += String.fromCharCode(value);
    if (it.nextToken() === COMMA) it.getToken();
  }
  it.getRightParen();
  return s;
});
defineS('str', K_TO_STRING, function (f) {
  const it = f.interp;
  it.getLeftParen();
  if (it.nextNextToken() === COMMA) {   // toString(number, decimalPlaces)
    const n = it.getExpression$s();
    const digits = toInt(f.getLastArg$s());
    return d2s(n, digits);
  }
  let s = f.getString$s();
  it.getToken();
  if (it.token === COMMA) {
    const value = toolsParseDouble(s, NaN);
    s = d2s(value, toInt(it.getExpression$s()));
    it.getToken();
  }
  if (it.token !== RP) it.error("')' expected");
  return s;
});
defineS('str', K_GET_ARGUMENT, (f) => { f.interp.getParens(); return f.interp.argument !== null ? f.interp.argument : ''; });
defineS('str', K_GET_VERSION, function (f) {
  f.interp.getParens();
  return hostVersion$s(f, f.interp.ctx.host);
}, { suspends: 'host' });
defineS('arr', K_NEW_ARRAY, function (f) {
  const it = f.interp;
  if (it.nextToken() !== LP || it.nextNextToken() === RP) {
    it.getParens();
    return [];
  }
  it.getLeftParen();
  const vector = [];
  do {
    const v = new Variable();
    if (f.isStringArg()) v.setString(f.getString$s());
    else v.setValue(it.getExpression$s());
    vector.push(v);
    it.getToken();
  } while (it.token === COMMA);
  if (it.token !== RP) it.error("';' expected");
  if (vector.length === 1 && vector[0].getString() === null) {
    const size = toInt(vector[0].getValue());
    if (size < 0) it.error('Negative array size');
    checkArraySize(it, size);
    const array2 = new Array(size);
    for (let i = 0; i < size; i++) array2[i] = new Variable();
    return array2;
  }
  return vector;
});
function runNestedMacro$s(f, code, arg) {
  const outer = f.interp;
  const nested = new Interpreter(outer.ctx);
  nested.argument = arg;
  nested.calledMacro = true;
  try {
    nested.run$s(code);
    return nested.returnValue;
  } catch (e) {
    if (e instanceof MacroCancel && e.kind === 'abort') throw e;
    if (isInternalFault(e)) throw e;
    if (e instanceof MacroCancel && e.kind === 'error' && nested.wasError && !nested.errorSilent)
      f.hostHook$s(() => outer.ctx.showError(nested.errorDialogText()));
    return '[aborted]';   // Macro_Runner.runMacro: a canceled or failed macro
  }
}
defineS('str', K_EVAL, function (f) {
  const it = f.interp;
  it.getLeftParen();
  const name = f.getString$s();
  let arg = null;
  if (it.nextToken() === COMMA) { it.getComma(); arg = f.getString$s(); }
  it.getRightParen();
  if (arg !== null && (name === 'script' || name === 'js')) {
    f.showMessage$s('Macro', 'Could not find JavaScript engine');
    return '';
  }
  if (arg !== null && (name === 'bsh' || name === 'python')) return f.notAvailable(K_EVAL, 'str');
  return runNestedMacro$s(f, name, arg);
}, { suspends: true });
defineS('str', K_RUN_MACRO, function (f) {
  const it = f.interp;
  it.getLeftParen();
  const name = f.getString$s();
  let arg = null;
  if (it.nextToken() === COMMA) { it.getComma(); arg = f.getString$s(); }
  it.getRightParen();
  const host = it.ctx.host;
  if (host && typeof host.runMacroFile === 'function') {
    const src = f.hostHook$s(() => host.runMacroFile(name, arg));
    if (src === null || src === undefined) return null;
    return runNestedMacro$s(f, String(src), arg);
  }
  f.showMessage$s('Macro Runner', 'Macro or script not found:\n \n' + name);
  return null;
}, { suspends: true });
defineS('num', K_RANDOM, function (f) {
  const it = f.interp;
  let dseed = NaN, gaussian = false;
  if (it.nextToken() === LP) {
    it.getLeftParen();
    if (f.isStringArg()) {
      const arg = (f.getString$s()).toLowerCase();
      if (arg === 'seed') {
        it.getComma();
        dseed = it.getExpression$s();
        let seed;
        if (dseed !== dseed) seed = 0n;
        else if (dseed >= 9223372036854775807) seed = 9223372036854775807n;
        else if (dseed <= -9223372036854775808) seed = -9223372036854775808n;
        else seed = BigInt(Math.trunc(dseed));
        if (Number(seed) !== dseed) it.error('Seed not integer');
        f.ran = new JavaRandom(seed);
        it.ctx.imageRandomSeed = Number(seed);
      } else if (arg === 'gaussian') gaussian = true;
      else it.error("'seed' or ''gaussian' expected");
    }
    it.getRightParen();
    if (dseed === dseed) return NaN;
  }
  it.ctx.imageRandomSeed = NaN;
  it.getParens();
  if (f.ran === null || f.ran === undefined) f.ran = new JavaRandom();
  return gaussian ? f.ran.nextGaussian() : f.ran.nextDouble();
});
defineS('arr', K_SPLIT, function (f) {
  const it = f.interp;
  const s1 = f.getFirstString$s();
  let s2 = null;
  if (it.nextToken() === RP) it.getRightParen();
  else s2 = f.getLastString$s();
  let strings;
  try {
    if (s1.length > 0 && s2 !== null && (s2 === ',' || s2 === ';')) strings = javaSplit(s1, s2);
    else if (s1.length > 0 && s2 !== null && s2.length >= 3 && s2.startsWith('(') && s2.endsWith(')'))
      strings = javaSplit(s1, s2.substring(1, s2.length - 1));
    else strings = (s2 === null || s2 === '') ? toolsSplit(s1) : toolsSplit(s1, s2);
  } catch (e) {
    if (isInternalFault(e)) throw e;
    it.error(errText(e));
    return [];
  }
  return strings.map((x) => Variable.string(x));
});
function padFn$s(f) {
  const it = f.interp;
  let stringArg = null, intArg = 0;
  it.getLeftParen();
  if (f.isStringArg()) stringArg = f.getString$s();
  else intArg = toInt(it.getExpression$s());
  const digits = toInt(f.getLastArg$s());
  checkStringSize(it, digits);
  return stringArg !== null ? ijPad(stringArg, digits) : ijPad('' + intArg, digits);
}
defineS('str', K_LIST, function (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === ARRAY_FUNCTION || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  if (f.props === null) f.props = new Map();
  const props = f.props;
  let value = null;
  const name = it.tokenString;
  if (name === 'get') {
    const v = props.get(f.getStringArg$s());
    value = v !== undefined ? v : '';
  } else if (name === 'getValue') {
    const v = props.get(f.getStringArg$s());
    if (v === undefined) it.error('Value not found');
    value = v === undefined ? null : v;
  } else if (name === 'set' || name === 'add' || name === 'put') {
    const key = f.getFirstString$s();
    props.set(key, f.getLastString$s());
  } else if (name === 'clear' || name === 'reset') {
    it.getParens();
    props.clear();
  } else if (name === 'setList') {
    const list = f.getStringArg$s();
    props.clear();
    try {
      for (const [k, v] of loadProperties(list)) props.set(k, v);
    } catch (e) { if (isInternalFault(e)) throw e; it.error(errText(e)); }
  } else if (name === 'getList') {
    it.getParens();
    value = sortedKeys(props).map((k) => k + '=' + props.get(k) + '\n').join('');
  } else if (name === 'size' || name === 'getSize') {
    it.getParens();
    value = '' + props.size;
  } else if (name === 'setMeasurements' || name === 'setCommands') {
    let arg = null;
    if (name === 'setMeasurements') {
      arg = '';
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (it.nextToken() !== RP) arg = (f.getString$s()).toLowerCase();
        it.getRightParen();
      }
    } else it.getParens();
    const r = f.hostCall$s('List.' + name, arg === null ? [] : [arg]);
    props.clear();
    if (r && typeof r === 'object') for (const k of Object.keys(r)) props.set(k, String(r[k]));
  } else if (name === 'indexOf') {
    const key = f.getStringArg$s();
    value = '' + sortedKeys(props).indexOf(key);
  } else if (name === 'fromArrays') {
    it.getLeftParen();
    const keys = f.getStringArray$s();
    it.getComma();
    const values = f.getStringArray$s();
    if (values.length !== keys.length) it.error('Arrays must have same length');
    props.clear();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === '') it.error('Key cannot be an empty string');
      props.set(keys[i], values[i]);
    }
    it.getRightParen();
  } else if (name === 'toArrays') {
    const keys = f.getFirstArrayVariable();
    const values = f.getLastArrayVariable();
    const ks = sortedKeys(props);
    keys.setArray(ks.map((k) => Variable.string(k)));
    values.setArray(ks.map((k) => Variable.string(props.get(k))));
  } else it.error('Unrecognized List function');
  return value;
}, { suspends: { setMeasurements: 'host', setCommands: 'host' } });
defineS('str', K_STRING, function (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === STRING_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'append': {
      const text = f.getStringArg$s();
      f.buffer = (f.buffer === null ? '' : f.buffer) + text;
      return null;
    }
    case 'resetBuffer': it.getParens(); f.buffer = ''; return null;
    case 'buffer': it.getParens(); if (f.buffer === null) f.buffer = ''; return f.buffer;
    case 'join': {
      it.getLeftParen();
      const arr = f.getArray$s();
      let delimiter = ', ';
      if (it.nextToken() === COMMA) delimiter = f.getNextString$s();
      it.getRightParen();
      return joinArray(arr, delimiter);
    }
    case 'trim': return javaTrim(f.getStringArg$s());
    case 'pad': return padFn$s(f);
    case 'format': {
      let result = null;
      try {
        const command = f.getFirstString$s();
        const params = [];
        while (it.nextToken() === COMMA) params.push(f.getNextArg$s());
        it.getRightParen();
        result = javaFormat(command, params);
      } catch (e) {
        if (e instanceof JavaEx) it.error('' + e);
        else throw e;
      }
      return result;
    }
    case 'copy': { const text = f.getStringArg$s(); f.hostCall$s('String.copy', [text]); return null; }
    case 'paste': it.getParens(); return f.hostCall$s('String.paste', []);
    case 'show': { const text = f.getStringArg$s(); f.hostCall$s('String.show', [text]); return null; }
    case 'copyResults': it.getParens(); f.hostCall$s('String.copyResults', []); return null;
    case 'getResultsHeadings': it.getParens(); return f.hostCall$s('String.getResultsHeadings', []);
    case 'setFontSize': { const size = toInt(f.getArg$s()); f.hostCall$s('String.setFontSize', [size]); return null; }
    default: it.error('Unrecognized String function'); return null;
  }
}, { suspends: { copy: 'host', paste: 'host', show: 'host', copyResults: 'host', getResultsHeadings: 'host', setFontSize: 'host' } });
defineS('str', K_IJ_CALL, function (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === NUMERIC_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'pad': return padFn$s(f);
    case 'deleteRows': {
      const first = toInt(f.getFirstArg$s()), last = toInt(f.getLastArg$s());
      f.hostCall$s('IJ.deleteRows', [first, last]);
      return null;
    }
    case 'log': it.log(f.getStringArg$s()); return null;
    case 'freeMemory': case 'currentMemory': case 'maxMemory': case 'getToolName': {
      it.getParens();
      const r = f.hostCall$s('IJ.' + name, []);
      return r === null || r === undefined ? null : '' + r;
    }
    case 'redirectErrorMessages': it.getParens(); f.hostCall$s('IJ.redirectErrorMessages', []); return null;
    case 'renameResults': {
      const arg1 = f.getFirstString$s();
      let arg2 = null;
      if (it.nextToken() === RP) it.getRightParen(); else arg2 = f.getLastString$s();
      f.hostCall$s('IJ.renameResults', arg2 !== null ? [arg1, arg2] : [arg1]);
      return null;
    }
    case 'getFullVersion': {
      it.getParens();
      const host = it.ctx.host;
      if (host && typeof host.getFullVersion === 'function') {
        const full = f.hostHook$s(() => host.getFullVersion());
        if (full !== undefined) return '' + full;
      }
      return IMAGEJ_VERSION + '99';   // ImageJ.VERSION + ImageJ.BUILD ("99" marks a release)
    }
    case 'checksum': {
      let method = f.getFirstString$s();
      const src = f.getLastString$s();
      method = method.toUpperCase();
      const file = method.indexOf('FILE') >= 0, str = method.indexOf('STRING') >= 0;
      const md = method.indexOf('MD5') >= 0, sha = method.indexOf('SHA-256') >= 0;
      if (str && md) return hex2(md5(utf8Bytes(src)));
      if (str && sha) return hex2(sha256(utf8Bytes(src)));
      if (file && (md || sha)) return f.hostCall$s('IJ.checksum', [md ? 'MD5' : 'SHA-256', src]);
      it.error("must contain 'file' or 'string' and 'MD5' or 'SHA-256'");
      return '0';
    }
    default: it.error('Unrecognized IJ function name'); return null;
  }
}, { suspends: { deleteRows: 'host', freeMemory: 'host', currentMemory: 'host', maxMemory: 'host', getToolName: 'host', renameResults: 'host', checksum: 'host', getFullVersion: 'host', redirectErrorMessages: 'host' } });
function sortArray$s(f) {
  const it = f.interp;
  it.getLeftParen();
  const a = f.getArray$s();
  const multipleArrays = it.nextToken() === COMMA;
  let indexes = null;
  const len = a.length;
  let nNumbers = 0;
  for (let i = 0; i < len; i++) if (a[i].getString() === null) nNumbers++;
  if (nNumbers === len) {
    const d = a.map((v) => v.getValue());
    if (multipleArrays) indexes = rankNumbers(d);
    d.sort(javaDoubleCompare);
    for (let i = 0; i < len; i++) a[i].setValue(d[i]);
  } else if (nNumbers === 0) {
    const s = a.map((v) => v.getString());
    if (multipleArrays) indexes = rankStrings(s);
    s.sort(compareToIgnoreCase);
    for (let i = 0; i < len; i++) a[i].setString(s[i]);
  } else {
    it.error('Mixed strings and numbers');
    return a;
  }
  while (it.nextToken() === COMMA) {
    it.getComma();
    const b = f.getArray$s();
    if (b.length !== len) { it.error('Arrays must have same length'); return a; }
    const c = new Array(len);
    for (let j = 0; j < len; j++) c[j] = b[indexes[j]];
    for (let j = 0; j < len; j++) b[j] = c[j];
  }
  it.getRightParen();
  return a;
}
function arrayStatistics$s(f) {
  const it = f.interp;
  it.getLeftParen();
  const a = f.getArray$s();
  const minv = f.getNextVariable$s();
  let maxv = null, mean = null, std = null;
  it.getToken();
  let arg = 1;
  while (it.token === COMMA) {
    arg++;
    switch (arg) {
      case 2: maxv = f.getVariable$s(); break;
      case 3: mean = f.getVariable$s(); break;
      case 4: std = f.getVariable$s(); break;
      default: it.error("')' expected");
    }
    it.getToken();
  }
  if (it.token !== RP) it.error("')' expected");
  const n = a.length;
  let sum = 0.0, sum2 = 0.0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const value = a[i].getValue();
    sum += value; sum2 += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  minv.setValue(min);
  if (maxv !== null) maxv.setValue(max);
  if (mean !== null) mean.setValue(sum / n);
  if (std !== null) {
    let stdDev = (n * sum2 - sum * sum) / n;
    stdDev = Math.sqrt(stdDev / (n - 1.0));
    std.setValue(stdDev);
  }
  return a;
}
function showArray$s(f) {
  const it = f.interp;
  let title = 'Arrays';
  const arrays = [], names = [];
  it.getLeftParen();
  do {
    if (f.isStringArg() && !f.isArrayArg()) title = f.getString$s();
    else {
      const addr = f.pgm.code[it.pc + 1] >> TOK_SHIFT;
      names.push(f.pgm.table[addr].str);
      arrays.push(f.getArray$s());
    }
    it.getToken();
  } while (it.token === COMMA);
  if (it.token !== RP) it.error("')' expected");
  if (arrays.length === 1 && title === 'Arrays') title = names[0];
  const cols = arrays.map((a) => a.map((v) => (v.getString() !== null ? v.getString() : v.getValue())));
  f.hostCall$s('Array.show', [title, arrays.length === 1 ? ['Value'] : names, cols]);
  return null;
}
defineS('arr', K_ARRAY_FUNC, function (f) {
  const it = f.interp;
  it.getToken();
  if (it.token !== DOT) it.error("'.' expected");
  it.getToken();
  if (!(it.token === WORD || it.token === PREDEFINED_FUNCTION || it.token === STRING_FUNCTION)) it.error('Function name expected: ');
  const name = it.tokenString;
  switch (name) {
    case 'copy': {
      it.getLeftParen();
      const a = f.getArray$s();
      it.getRightParen();
      return duplicate(a);
    }
    case 'trim': {
      it.getLeftParen();
      const a1 = f.getArray$s();
      let size = toInt(f.getLastArg$s());
      if (size < 0) size = 0;
      if (size > a1.length) size = a1.length;
      return duplicate(a1.slice(0, size));
    }
    case 'sort': return sortArray$s(f);
    case 'rankPositions': {
      it.getLeftParen();
      const a = f.getArray$s();
      it.getRightParen();
      const len = a.length;
      let nNumbers = 0;
      for (let i = 0; i < len; i++) if (a[i].getString() === null) nNumbers++;
      if (nNumbers !== len && nNumbers !== 0) { it.error('Mixed strings and numbers'); return a; }
      const indexes = nNumbers === len ? rankNumbers(a.map((v) => v.getValue())) : rankStrings(a.map((v) => v.getString()));
      return indexes.map((x) => Variable.num(x));
    }
    case 'getStatistics': return arrayStatistics$s(f);
    case 'sequence': case 'getSequence': {
      const n = toInt(f.getArg$s());
      if (n < 0) { it.error('Negative array size'); return []; }
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = Variable.num(i);
      return a;
    }
    case 'fill': {
      it.getLeftParen();
      const a = f.getArray$s();
      const v = f.getLastArg$s();
      for (let i = 0; i < a.length; i++) a[i].setValue(v);
      return a;
    }
    case 'reverse': case 'invert': {
      it.getLeftParen();
      const a = f.getArray$s();
      it.getRightParen();
      const n = a.length;
      for (let i = 0; i < Math.floor(n / 2); i++) { const t = a[i]; a[i] = a[n - i - 1]; a[n - i - 1] = t; }
      return a;
    }
    case 'concat': {
      it.getLeftParen();
      const list = [];
      do {
        if (f.isArrayArg()) { for (const v of f.getArray$s()) list.push(v.clone()); }
        else if (f.isStringArg()) list.push(Variable.string(f.getString$s()));
        else list.push(Variable.num(it.getExpression$s()));
        it.getToken();
      } while (it.token === COMMA);
      return list;
    }
    case 'slice': {
      it.getLeftParen();
      const a = f.getArray$s();
      const len = a.length;
      let i1 = toInt(f.getNextArg$s());
      let i2 = len;
      if (it.nextToken() === COMMA) { it.getComma(); i2 = toInt(it.getExpression$s()); }
      if (i1 < 0) it.error('Invalid argument');
      if (i2 > len) i2 = len;
      let len2 = i2 - i1;
      if (len2 < 0) len2 = 0;
      if (len2 > len) len2 = len;
      it.getRightParen();
      const a2 = new Array(len2);
      for (let i = 0; i < len2; i++) a2[i] = a[i1++].clone();
      return a2;
    }
    case 'print': {
      let prefix = null;
      it.getLeftParen();
      if (!f.isArrayArg() && f.isStringArg()) { prefix = f.getString$s(); it.getComma(); }
      const a = f.getArray$s();
      it.getRightParen();
      let str = joinArray(a, ', ');
      if (prefix !== null) str = prefix + ' ' + str;
      it.log(str);
      return null;
    }
    case 'resample': {
      it.getLeftParen();
      const a1 = f.getArray$s();
      const len1 = a1.length;
      const len2 = toInt(f.getLastArg$s());
      if (len1 === 0 || len2 <= 0) { it.error('Cannot resample from or to zero-length'); return []; }
      return resampleArray(a1.map((v) => v.getValue()), len2).map((x) => Variable.num(x));
    }
    case 'findMaxima': case 'findMinima': {
      let edgeMode = 0;
      it.getLeftParen();
      const a = f.getArray$s();
      const tolerance = f.getNextArg$s();
      if (it.nextToken() === COMMA) { it.getComma(); edgeMode = toInt(it.getExpression$s()); }
      it.getRightParen();
      const d = a.map((v) => v.getValue());
      const res = name === 'findMinima' ? findMaxima1D(d.map((x) => -x), tolerance, edgeMode) : findMaxima1D(d, tolerance, edgeMode);
      return res.map((x) => Variable.num(x));
    }
    case 'show': return showArray$s(f);
    case 'fourier': {
      it.getLeftParen();
      const a = f.getArray$s();
      let windowType = 'none';
      if (it.nextToken() === COMMA) {
        it.getComma();
        const w = (f.getString$s()).toLowerCase();
        if (w === 'hamming') windowType = 'hamming';
        else if (w.startsWith('hann')) windowType = 'hann';
        else if (w.startsWith('flat')) windowType = 'flat';
        else if (!w.startsWith('no')) it.error("Invalid Fourier window '0'");
      }
      it.getRightParen();
      const n = a.length;
      if (windowType !== 'none' || n < 2 || (n & (n - 1)) !== 0) {
        it.error('Function not available in the browser: Array.fourier (only the "none" window on a power-of-two length is reproduced)');
        return [];
      }
      return fourierAmplitudes(a.map((v) => Math.fround(v.getValue()))).map((x) => Variable.num(x));
    }
    case 'getVertexAngles': {
      it.getLeftParen();
      const xx = f.getArray$s();
      it.getComma();
      const yy = f.getArray$s();
      it.getComma();
      const arm = toInt(it.getExpression$s());
      const len = xx.length;
      if (yy.length !== len) it.error('Same size expected');
      it.getRightParen();
      const x = xx.map((v) => v.getValue()), y = yy.map((v) => v.getValue());
      const out = new Array(len);
      for (let mid = 0; mid < len; mid++) {
        const left = (mid + 10 * len - arm) % len, right = (mid + arm) % len;
        const dot = (x[right] - x[mid]) * (x[left] - x[mid]) + (y[right] - y[mid]) * (y[left] - y[mid]);
        const cross = (x[right] - x[mid]) * (y[left] - y[mid]) - (y[right] - y[mid]) * (x[left] - x[mid]);
        let phi = 180.0 - 180.0 / Math.PI * Math.atan2(cross, dot);
        while (phi >= 180.0) phi -= 360.0;
        out[mid] = Variable.num(phi);
      }
      return out;
    }
    case 'rotate': {
      it.getLeftParen();
      const a = f.getArray$s();
      it.getComma();
      let rot = toInt(it.getExpression$s());
      it.getRightParen();
      const len = a.length;
      if (len === 0) return a;
      while (rot < 0) rot += len;
      const b = new Array(len);
      for (let i = 0; i < len; i++) b[(i + rot) % len] = a[i];
      for (let i = 0; i < len; i++) a[i] = b[i];
      return a;
    }
    case 'deleteValue': case 'delete': {
      it.getLeftParen();
      const arr1 = f.getArray$s();
      let value = Number.MAX_VALUE, stringValue = null;
      it.getComma();
      if (f.isStringArg()) stringValue = f.getString$s();
      else value = it.getExpression$s();
      it.getRightParen();
      const out = [];
      for (const v of arr1) {
        const type = v.getType();
        let remove = false;
        if (stringValue !== null) {
          if (type === V_STRING) remove = stringValue === v.getString();
        } else if (type === V_VALUE) {
          const val = v.getValue();
          remove = val === value || (val !== val && value !== value);
        }
        if (!remove) out.push(v.clone());
      }
      return out;
    }
    case 'deleteIndex': {
      it.getLeftParen();
      const arr1 = f.getArray$s();
      const index = toInt(f.getLastArg$s());
      f.checkIndex(index, 0, arr1.length - 1);
      const out = [];
      for (let i = 0; i < arr1.length; i++) if (i !== index) out.push(arr1[i].clone());
      return out;
    }
    case 'filter': {
      it.getLeftParen();
      const a1 = f.getArray$s();
      const filter = f.getLastString$s();
      const out = [];
      for (const v of a1) {
        const str = v.getString();
        if (str === null) continue;
        let contains;
        if (filter.startsWith('(') && filter.endsWith(')')) {
          try { contains = javaRegex(filter.substring(1, filter.length - 1), false).test(str); }
          catch (e) { if (isInternalFault(e)) throw e; it.error(errText(e)); return []; }
        } else contains = str.indexOf(filter) >= 0;
        if (contains) out.push(v);
      }
      return out;
    }
    default:
      it.error('Unrecognized Array function');
      return null;
  }
}, { suspends: { show: 'host' } });
defineS('do', K_SET_OPTION, function (f) {
  const it = f.interp;
  const arg1 = f.getFirstString$s();
  let state = true;
  if (it.nextToken() === COMMA) {
    it.getComma();
    const arg2 = it.getBooleanExpression$s();
    it.checkBoolean(arg2);
    state = arg2 !== 0;
  }
  it.getRightParen();
  if (arg1.toLowerCase().startsWith('expandablearrays')) f.expandableArrays = state;
  else f.hostCall$s('setOption', [arg1, state]);
}, { suspends: 'host' });
defineS('do', K_WAIT, function (f) {
  const n = toInt(f.getArg$s());
  if (n > 0) {
    const sig = f.interp.ctx.signal;
    syncAwait(new Promise((resolve) => {
      const done = () => { clearTimeout(t); if (sig) sig.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, n);
      if (sig) sig.addEventListener('abort', done, { once: true });
    }));
  }
}, { suspends: true });
defineS('do', K_SHOW_MESSAGE, function (f) {
  const it = f.interp;
  it.getLeftParen();
  let title = f.getString$s();
  let message;
  if (it.nextToken() === COMMA) { it.getComma(); message = f.getString$s(); }
  else { message = title; title = ''; }
  it.getRightParen();
  f.showMessage$s(title, message);
}, { suspends: true });
/* ======================================================================================
 * Synchronous fast path
 *
 * The interpreter above is a set of generators so that a host built-in may return a Promise (the driver awaits it).
 * A generator costs about 3x a plain function; most statements of a macro never wait. So every generator method of
 * Interpreter / Functions has a generated plain-function twin (suffix $s, installed on the SAME prototypes: both paths
 * read and write the same state objects, the same tokens are consumed, the same errors and lines come out).
 * tools/gen_ijm_sync.mjs writes the twin between the markers below; this file's generators stay the only source.
 *
 * Dispatch (Interpreter.doStatement, the loop bodies, doBlock, doIf, user-function bodies): a statement that CANNOT
 * SUSPEND runs in the twin as a whole. "Cannot suspend" is decided from the tokens, once per statement start
 * (SyncAnalysis.classify, memoised in Interpreter.syncMemo):
 *   - a built-in may suspend when it is registered { suspends: true }, or 'host' (a built-in that reaches the host: it
 *     may suspend unless ctx.host.syncFunctions, a Set of names such as 'getPixel' or 'List.setMeasurements', declares
 *     it synchronous), or a { sub: ... } map for a namespace (Array.show), or a predicate (pgm, tokenIndex, host);
 *     a built-in defined later through IJMacro.defineS() without an option defaults to 'host';
 *   - a user function may suspend when its body does, transitively (fixed point over the call graph), or calls a name
 *     that is not a known function;
 *   - eval() / runMacro() / wait() / showMessage() / requires() / exit("msg") / print("[Window]", ..) are registered so.
 * A statement with a loop in it (or a call to a function that has one) that cannot suspend is class SYNC_LOOP: the
 * generator keeps the loop CONTROL (so the event loop is released and an abort is honoured every TICK_MASK+1
 * iterations, exactly as before) while the loop header and every body statement run in the twin, with no generator
 * allocated per iteration. Everything else is SYNC_GEN: executed by the generators, which dispatch their own inner
 * statements the same way.
 *
 * A user function on a cycle of the call graph (recursion, direct or through others) counts like a loop: a statement that
 * calls into it is SYNC_LOOP, so the call runs on the generators, which slice every TICK_MASK+1 calls (an abort is
 * honoured within sliceMs) and hop to a fresh native stack every FN_NEST_STEP levels (ImageJ's 1000 levels fit). Only the
 * statements of the body that do not call into the cycle stay in the twin. A page is not cross-origin isolated here, so a
 * SharedArrayBuffer abort flag cannot exist, and a timer cannot fire while the twin holds the thread: letting a recursion
 * run whole in the twin (option syncRecursion) therefore means it cannot be stopped short of terminating the worker.
 *
 * Policy for a stretch that runs in the twin and cannot syncAwait((a loop-free, recursion-free statement: a long pure
 * built-in): it keeps the thread until it ends. Every SYNC_TICK_MASK+1 (1024) user-function calls it looks at
 * ctx.abortFlag (an Int32Array on a SharedArrayBuffer the host sets to non-zero; Atomics.load) and at signal.aborted,
 * and throws the "Macro canceled" path); that only helps where a SharedArrayBuffer exists or when the signal was aborted
 * before the stretch. ctx.syncLoops / ctx.syncRecursion (options) let loops / recursions run whole in the twin
 * (fastest, same limit); ctx.fastPath === false (option fastPath) turns the whole mechanism off.
 * ==================================================================================== */
/* END GENERATED SYNC TWIN */
coreDefining = false;

/* ======================================================================================
 * The driver
 * ==================================================================================== */
const macrotask = () => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, 0) : resolve()));

const ABORTED = { aborted: true };
async function drive(gen, ctx) {
  const stack = [gen];
  /* Step the generator on top of `stack`; a finished one resumes its parent, a throw unwinds into it. */
  const resume = (mode, arg) => {
    for (;;) {
      const g = stack[stack.length - 1];
      let r;
      try { r = mode === 'next' ? g.next(arg) : g.throw(arg); }
      catch (e) {
        stack.pop();
        if (stack.length === 0) throw e;
        mode = 'throw'; arg = e; continue;
      }
      if (r.done) {
        stack.pop();
        if (stack.length === 0) return r;
        mode = 'next'; arg = r.value; continue;
      }
      if (r.value instanceof Sub) { stack.push(r.value.gen); mode = 'next'; arg = undefined; continue; }
      return r;
    }
  };
  let sliceStart = Date.now();
  const flag = ctx.abortFlag || null;
  const aborted = () => !!(ctx.signal && ctx.signal.aborted) || (flag !== null && Atomics.load(flag, 0) !== 0);
  let step = aborted() ? resume('throw', new MacroCancel('abort')) : resume('next');
  for (;;) {
    if (step.done) return step.value;
    const y = step.value;
    if (y === SLICE) {
      if (aborted()) { step = resume('throw', new MacroCancel('abort')); continue; }
      if (Date.now() - sliceStart >= ctx.sliceMs) {
        await macrotask();
        sliceStart = Date.now();
        if (aborted()) { step = resume('throw', new MacroCancel('abort')); continue; }
      }
      step = resume('next');
    } else if (isThenable(y)) {
      let v, failed = false, err;
      try { v = await (ctx.abortPromise ? Promise.race([y, ctx.abortPromise]) : y); } catch (e) { failed = true; err = e; }
      sliceStart = Date.now();
      if (v === ABORTED || aborted()) step = resume('throw', new MacroCancel('abort'));
      else if (failed) step = resume('throw', err);
      else step = resume('next', v);
    } else
      step = resume('next', y);
  }
}

/* The run context of a driver: the host, the abort wiring and the callbacks a built-in reaches through interp.ctx. */
function runContext(opts, onAbortSet) {
  const host = opts.host || null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
  const signal = opts.signal || null;
  return {
    host,
    signal,
    /* resolves with ABORTED when the signal fires, so a pending wait or host promise stops the macro at once */
    abortPromise: signal ? new Promise((resolve) => {
      if (signal.aborted) resolve(ABORTED);
      else { const f = () => resolve(ABORTED); onAbortSet(f); signal.addEventListener('abort', f, { once: true }); }
    }) : null,
    sliceMs: typeof opts.sliceMs === 'number' ? opts.sliceMs : 50,
    fastPath: opts.fastPath !== false,
    syncLoops: opts.syncLoops === true,
    syncRecursion: opts.syncRecursion === true,
    abortFlag: opts.abortFlag || null,
    log(s) { if (s === null || s === undefined) return; if (onLog) onLog(String(s)); },
    showMessage(title, text) {
      if (host && typeof host.showMessage === 'function') return host.showMessage(title, text);
    },
    /* The error window ImageJ shows for a failed nested macro (eval, runMacro). */
    showError(text) {
      if (host && typeof host.showError === 'function') return host.showError(text);
      if (host && typeof host.showMessage === 'function') return host.showMessage('Macro Error', text);
    },
  };
}

function errorOf(interp) {
  return { message: interp.errorMessage, line: interp.lineNumber, lineText: interp.errorLine, excerpt: interp.errorLine,
    calledFrom: interp.errorStack || [], silent: interp.errorSilent === true,
    dialogText: interp.errorSilent === true ? null : interp.errorDialogText() };
}

const PREPARED = Symbol('IJMacro.prepared');
const isPrepared = (x) => x !== null && typeof x === 'object' && x[PREPARED] === true;

/* IJMacro.prepare: MacroInstaller.install's view of a set (:71-98): the program tokenized once, the start of every
 * macro "Name" block (token index of the MACRO token + 2, the block's left brace) and whether the top-level var
 * statements must run before an entry (hasVars && macroCount > 0, MacroInstaller.install :78). */
function prepare(source) {
  const program = tokenize(String(source));
  const macros = [];
  const code = program.code;
  for (let i = 0; i < code.length; i++) {
    const t = code[i] & TOK_MASK;
    if (t === K_MACRO && (code[i + 1] & TOK_MASK) === STRING_CONSTANT)
      macros.push(Object.freeze({ name: program.table[code[i + 1] >> TOK_SHIFT].str, start: i + 2, line: program.lineNumbers[i] }));
    if (t === EOF) break;
  }
  return Object.freeze({ program, macros: Object.freeze(macros), needsGlobals: !!(program.hasVars && program.macroCount > 0), [PREPARED]: true });
}

/* new Interpreter().saveGlobals(pgm): the top-level var statements of a set, run once; their Variable objects are then
 * shared by every run of the set (pushGlobals), which is how an installed set's globals persist between entries. */
function* saveGlobalsOnce(ctx, pgm) {
  if (pgm.globals !== null) return;
  const g = new Interpreter(ctx);
  yield* g.saveGlobals2(pgm);
}

/* Interpreter.runMacro(pgm, macroLoc, name) (:175-192), and run(Program) for a prepared set without an entry. */
function* runPrepared(interp, P, entry) {
  const pgm = P.program;
  if (!entry) {
    if (pgm.hasVars && pgm.hasFunctions) yield* saveGlobalsOnce(interp.ctx, pgm);
    yield* interp.runProgram(pgm);
    return;
  }
  if (P.needsGlobals) yield* saveGlobalsOnce(interp.ctx, pgm);
  if (entry.start === -1) return;
  interp.calledMacro = true;
  interp.pgm = pgm;
  interp.pc = entry.start - 1;
  interp.callDepth = 0;
  interp.syncReset();
  interp.pushGlobals();
  if (interp.func === null) interp.func = new Functions(interp, pgm); else interp.func.pgm = pgm;
  interp.done = false;
  interp.errorMessage = null;
  if (entry.start === 0) yield* interp.doStatements(); else yield* interp.doBlock();
  interp.finishUp();
}

/* L5: a variable as the stack holds it after a run, top-down (Interpreter.getVariable2 order); null = absent. */
function readVariable(interp, name) {
  if (!interp.stack || !interp.pgm) return null;
  const table = interp.pgm.table;
  for (let i = interp.topOfStack; i >= 0; i--) {
    const v = interp.stack[i];
    if (!v || !table[v.symTabIndex] || table[v.symTabIndex].str !== name) continue;
    const arr = v.getArray();
    if (arr !== null) {
      const out = [];
      const n = v.getArraySize();
      for (let k = 0; k < n; k++) {
        const e = arr[k];
        out.push(e === null || e === undefined ? 0 : e.getString() !== null ? e.getString() : e.getValue());
      }
      return { a: out };
    }
    if (v.getString() !== null) return { s: v.getString() };
    return { n: v.getValue() };
  }
  return null;
}

/* IJMacro.run: interprets `source` (text, or a Prepared of IJMacro.prepare with an optional entry); resolves, never rejects. */
async function run(source, opts) {
  opts = opts || {};
  const signal = opts.signal || null;
  let onAbort = null;
  const ctx = runContext(opts, (f) => { onAbort = f; });
  const interp = new Interpreter(ctx);
  interp.argument = opts.arg === undefined ? null : opts.arg;
  let aborted = false, exited = false, internal = null;
  try {
    if (isPrepared(source)) {
      const e = opts.entry || null;
      if (e !== null && (typeof e.start !== 'number' || (e.start | 0) !== e.start || e.start < -1 || e.start >= source.program.code.length))
        throw new JavaException('Internal error: bad macro entry');
      await drive(runPrepared(interp, source, e), ctx);
    } else
      await drive(interp.run(String(source)), ctx);
  } catch (e) {
    if (e instanceof MacroCancel) {
      if (e.kind === 'abort') aborted = true;
      else if (e.kind === 'exit') exited = true;
    } else if (e instanceof JavaException) internal = e.message;
    else if (e instanceof RangeError && /call stack/i.test(e.message)) {
      /* The native stack ran out before ImageJ's own 1000-slot limit (a small worker stack, a deep recursion in the plain
       * twin): report it the way Interpreter.push does, with the line of the statement that was running. */
      try { interp.errorCount = 0; interp.ignoreErrors = false; interp.done = false; interp.error('Stack overflow'); } catch (e2) { /* the error is recorded */ }
      if (!interp.wasError) internal = 'Stack overflow';
    }
    else if (e instanceof RangeError && /Invalid (string|array) length/.test(e.message)) internal = 'Out of memory';
    else internal = 'Internal error: ' + (e && e.message ? e.message : String(e));
  }
  if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  let error = null;
  if (interp.wasError) error = errorOf(interp);
  else if (internal !== null)
    error = { message: internal, line: interp.lineNumber, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: null };
  const vars = {};
  if (Array.isArray(opts.readVars)) for (const n of opts.readVars) vars[String(n)] = readVariable(interp, String(n));
  return { ok: error === null && !aborted, error, aborted, exited, returnValue: interp.returnValue, vars };
}

/* Program.hasWord (:265-276): a symbol token whose string is the word, scanning to EOF (string constants count). */
function hasWord(pgm, word) {
  const code = pgm.code;
  for (let i = 0; i < code.length; i++) {
    const t = code[i];
    if (t <= 127) continue;
    if (t === EOF) return false;
    const sym = pgm.table[t >> TOK_SHIFT];
    if (sym && sym.str !== null && sym.str === word) return true;
  }
  return false;
}

const PIXEL_PREFIX = 'var v,x,y,z,w,h,d,a;\nfunction dummy() {}\n';
const PC_START = 23;

/* IJMacro.pixelProgram: ImageMath.applyMacro (:230-260): the code runs once as Interpreter.run(code, null) (its side effects
 * happen there), then each pixel sets v / x / y / a / d and runs the statements from PC_START (the first token after the
 * prefix). The first run goes through the driver (time-sliced, stopped by opts.signal). A pixel runs in the synchronous twin
 * (runSync) unless the code holds a loop (`needsDrive`): a loop can be endless, and a twin loop neither yields nor sees the
 * signal, so such a code runs each pixel through the driver (runAsync, sliced every opts.sliceMs, default 50). Recursion needs
 * no driver: it ends at ImageJ's stack limit. */
async function pixelProgram(code, opts) {
  opts = opts || {};
  code = String(code);
  const head = tokenize(code);
  let needsDrive = false;
  for (let i = 0; i < head.code.length; i++) {
    const t = head.code[i] & TOK_MASK;
    if (t === EOF) break;
    if (t === K_WHILE || t === K_FOR || t === K_DO) { needsDrive = true; break; }
  }
  let onAbort = null;
  const ctx = runContext({ host: opts.host || null, onLog: opts.onLog, signal: opts.signal || null, sliceMs: typeof opts.sliceMs === 'number' ? opts.sliceMs : 50 },
    (f) => { onAbort = f; });
  const interp = new Interpreter(ctx);
  interp.calledMacro = true;
  let internal = null;
  try { await drive(interp.run(PIXEL_PREFIX + code + ';\n'), ctx); }
  catch (e) {
    if (e instanceof MacroCancel) { if (!interp.wasError && e.kind === 'abort') internal = MACRO_CANCELED; }
    else if (e instanceof JavaException) internal = e.message;
    else throw e;
  }
  // the listener stays while the program lives (runAsync reads the same context); dispose() removes it
  if ((interp.wasError || internal !== null) && opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
  if (interp.wasError) return { ok: false, error: errorOf(interp) };
  if (internal !== null)
    return { ok: false, error: { message: internal, line: interp.lineNumber, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: null } };
  const stack = interp.stack;
  const table = interp.pgm.table;
  /* Interpreter.setVariable / getVariable: the first slot of the stack (bottom-up) whose name matches; the globals' slots never
   * move between pixels, so the slot found once is kept. */
  const slots = new Map();
  const find = (name) => {
    const k = slots.get(name);
    if (k !== undefined && k <= interp.topOfStack) return stack[k];
    for (let i = 0; i <= interp.topOfStack; i++) {
      const s = stack[i];
      if (s && table[s.symTabIndex].str === name) { if (i <= interp.topOfGlobals) slots.set(name, i); return s; }
    }
    return null;
  };
  const hostText = () => {
    const h = opts.host;
    return h && h.texts && typeof h.texts['err.macMathHost'] === 'string' ? h.texts['err.macMathHost'] : 'err.macMathHost';
  };
  const plain = (message) => ({ message, line: interp.lineNumber, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: message });
  const failure = (e) => {
    if (e instanceof MacroCancel) {
      if (interp.wasError) return errorOf(interp);
      return e.kind === 'abort' ? Object.assign(plain(MACRO_CANCELED), { silent: true, dialogText: null, aborted: true }) : null;
    }
    if (e instanceof SyncViolation) return plain(hostText());
    if (e instanceof JavaException) return plain(e.message);
    throw e;
  };
  const rewind = () => {
    interp.topOfStack = interp.topOfGlobals;
    interp.done = false;
    interp.pc = PC_START - 1;
  };
  return {
    ok: true,
    hasX: hasWord(head, 'x'), hasA: hasWord(head, 'a'), hasD: hasWord(head, 'd'), hasGetPixel: hasWord(head, 'getPixel'), needsDrive,
    set(name, value) { const v = find(name); if (v !== null) v.setValue(value); },
    get(name) { const v = find(name); return v === null ? NaN : v.getValue(); },
    runSync() {
      rewind();
      try { interp.doStatements$s(); }
      catch (e) { return failure(e); }
      return interp.wasError ? errorOf(interp) : null;
    },
    async runAsync() {
      rewind();
      try { await drive(interp.doStatements(), ctx); }
      catch (e) { return failure(e); }
      return interp.wasError ? errorOf(interp) : null;
    },
    dispose() { slots.clear(); if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort); },
  };
}

/* IJMacro.compile: the tokenized program and a summary of what it declares. */
function compile(source) {
  const program = tokenize(String(source));
  const macros = [], functions = [], tokens = [];
  const code = program.code;
  for (let i = 0; i < code.length; i++) {
    const t = code[i] & TOK_MASK;
    tokens.push({ index: i, line: program.lineNumbers[i], token: t, text: program.decodeToken(code[i]) });
    if (t === K_MACRO && (code[i + 1] & TOK_MASK) === STRING_CONSTANT)
      macros.push(program.table[code[i + 1] >> TOK_SHIFT].str);
    else if (t === K_FUNCTION && (code[i + 1] & TOK_MASK) === WORD)
      functions.push(program.table[code[i + 1] >> TOK_SHIFT].str);
    if (t === EOF) break;
  }
  return { program, macros, functions, tokens };
}

/* IJMacro.analyze: how the fast path would dispatch each top-level statement of `source` ('twin' = plain twin,
 * 'loop' = loop control on the generators, parts in the twin, 'gen' = generators) and which user functions may
 * suspend / loop. opts: { host, syncLoops }. For tests and for a host that wants to know why a macro is slow. */
function analyze(source, opts) {
  opts = opts || {};
  const pgm = tokenize(String(source));
  const an = new SyncAnalysis(pgm, { host: opts.host || null, syncLoops: opts.syncLoops === true, syncRecursion: opts.syncRecursion === true });
  const code = pgm.code;
  const statements = [];
  let i = 0;
  while (i < code.length && (code[i] & TOK_MASK) !== EOF) {
    const t = code[i] & TOK_MASK;
    if (t === K_FUNCTION || t === K_MACRO) {
      let j = i;
      while (j < code.length && (code[j] & TOK_MASK) !== LBRACE && (code[j] & TOK_MASK) !== EOF) j++;
      const e = an.blockEnd(j);
      i = e < 0 ? code.length : e;
      continue;
    }
    const e = an.stmtEnd(i);
    if (e < 0) { i++; continue; }
    if (!(t === SEMI)) {
      const cls = an.classify(i);
      statements.push({ line: pgm.lineNumbers[i], class: cls === SYNC_TWIN ? 'twin' : cls === SYNC_LOOP ? 'loop' : 'gen' });
    }
    i = e;
  }
  const functions = {};
  for (const [a, f] of an.functions()) functions[pgm.table[a].str] = { suspends: f.susp, loops: f.loopy, recursive: f.rec };
  return { statements, functions };
}

/* Which MacroConstants ids have a built-in and which wait for a later stage. */
function coverage() {
  const out = { implemented: [], missing: [] };
  for (const kind of Object.keys(BUILTINS)) {
    const list = { do: SYS_FUNCTIONS, num: SYS_NUMERICFUNCTIONS, str: SYS_STRINGFUNCTIONS, arr: SYS_ARRAYFUNCTIONS, variable: SYS_VARIABLEFUNCTIONS }[kind];
    for (const [name, id] of list) (BUILTINS[kind].has(id) ? out.implemented : out.missing).push(kind + ':' + name);
  }
  return out;
}

return { run, prepare, pixelProgram, PC_START, PIXEL_PREFIX, hasWord, tokenize, compile, define, coverage, analyze, BUILTINS, K, NAME_OF, d2s, d2s3, numToString, javaDouble, parseJavaDouble,
  Interpreter, Functions, Variable, Program, MacroCancel, SLICE };
})();
