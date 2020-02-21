"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var makerjs_1 = __importDefault(require("makerjs"));
var xml2js_1 = __importDefault(require("xml2js"));
// unfortunately dxf has no types
var _a = require('dxf'), Helper = _a.Helper, entityToBoundsAndElement = _a.entityToBoundsAndElement, colors = _a.colors;
var tol = 0.0001;
var minPadX = 0.2;
var rgbToHex = function (rgb) {
    var hex = Number(rgb).toString(16);
    if (hex.length < 2) {
        hex = "0" + hex;
    }
    return hex;
};
function rgbToColorAttribute(rgb) {
    if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) {
        return '#000000)';
    }
    else {
        return "#" + rgbToHex(rgb[0]) + rgbToHex(rgb[1]) + rgbToHex(rgb[2]);
    }
}
function categorize(entities) {
    var textsByColor = {};
    var entitiesByColor = {};
    entities.forEach(function (entity) {
        if (entity.type === "MTEXT") {
            var existing = textsByColor[entity.colorNumber];
            if (existing) {
                existing.push(entity.string);
            }
            else {
                textsByColor[entity.colorNumber] = Array(entity.string);
            }
        }
        else {
            var existing = entitiesByColor[entity.colorNumber];
            if (existing) {
                existing.push(entity);
            }
            else {
                entitiesByColor[entity.colorNumber] = Array(entity);
            }
        }
    });
    return { textsByColor: textsByColor, entitiesByColor: entitiesByColor };
}
function checkForDuplicates(textsByColor) {
    var duplicateKey = Object.keys(textsByColor).find(function (key) { return textsByColor[key].length > 1; });
    return duplicateKey ? textsByColor[duplicateKey].map(function (t) { return "\"" + t + "\""; }) : [];
}
function modelFromPaths(paths) {
    var makerobjects = paths.map(function (pathData) {
        var pathModel = makerjs_1.default.importer.fromSVGPathData(pathData);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        var mirroredModel = makerjs_1.default.model.mirror(pathModel, false, true);
        makerjs_1.default.model.originate(mirroredModel);
        makerjs_1.default.model.simplify(mirroredModel);
        return mirroredModel;
    });
    var obj = makerobjects.reduce(function (acc, cur, i) {
        acc[i] = cur;
        return acc;
    }, {});
    var model = { models: obj };
    return model;
}
function modelFromCircles(circles) {
    var circlePaths = circles.map(function (circle) {
        var radius = parseFloat(circle.$.r);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        var center = [parseFloat(circle.$.cx), parseFloat(circle.$.cy)];
        return new makerjs_1.default.paths.Circle(center, radius);
    });
    var pathMap = circlePaths.reduce(function (acc, cur, i) {
        acc[i] = cur;
        return acc;
    }, {});
    return { paths: pathMap };
}
function createParts(textsByColor, entitiesByColor, svgObj, warnings) {
    var objectsByColor = {};
    Object.keys(entitiesByColor).forEach(function (color) {
        var paths = entitiesByColor[color].map(function (entity) {
            var element = entityToBoundsAndElement(entity).element;
            if (element.startsWith("<path d=") && element.endsWith(" />")) {
                var length_1 = element.length;
                return element.substring(9, length_1 - 9 - 5);
            }
            else {
                console.log("entity " + entity.type + " lead to an unusable svg of ", element);
                return undefined;
            }
        });
        objectsByColor[color] = modelFromPaths(paths);
    });
    var partNames = {
        bridge: ["bridge", "bruecke", "brücke"],
        shape: ["shape", "front", "frame", "shape_left", "shape_right"],
        hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
        pad: ["pad", "pad_left", "pad_right"]
    };
    var parts = {};
    Object.keys(partNames).forEach(function (part) {
        var names = partNames[part];
        var color = Object.keys(textsByColor).find(function (color) {
            var texts = textsByColor[color];
            return texts.find(function (text) { return names.includes(text.toLowerCase()); }) !== undefined;
        });
        if (!color) {
            warnings.push({ term: "frameupload.dxfwarning.missingAnnotation", data: { NAME: part } });
        }
        else {
            var object = objectsByColor[color];
            if (!object) {
                warnings.push({ term: "frameupload.dxfwarning.missingCurve", data: { NAME: part } });
            }
            else {
                if (svgObj && svgObj.svg && svgObj.svg.g.length > 0 && svgObj.svg.g[0].path) {
                    var firstGroup = svgObj.svg.g[0];
                    var paths = firstGroup.path;
                    var rgb_1 = rgbToColorAttribute(colors[color]);
                    var matchingPaths = paths.filter(function (path) { return path.$ && path.$.style.startsWith && path.$.style.startsWith("stroke:" + rgb_1); });
                    if (matchingPaths.length > 0) {
                        parts[part] = modelFromPaths(matchingPaths.map(function (path) { return path.$.d; }));
                    }
                    if (firstGroup.circle && firstGroup.circle.length > 0) {
                        var colorFittingCircles = firstGroup.circle.filter(function (c) { return c.$.style.startsWith("stroke:" + rgb_1); });
                        if (part === "shape") {
                            parts[part + "_holes"] = modelFromCircles(colorFittingCircles);
                        }
                        else {
                            console.log("Unhandled circles for " + part + ": ", firstGroup.circle);
                        }
                    }
                }
            }
        }
    });
    return parts;
}
/**
 * analyzes the dxfContents and creates a preview SVG for viewing of the uploaded
 * the converted SVG isn't very high quality, so before we can use maker.js to really work on it
 * we need to upload the file to the cloud to properly convert it to a higher quality svg
 *
 * @param dxfContents the uploaded original DXF file contents
 * @param svgContents the contents of the high quality svg converted in the cloud
 */
function analyzeDXF(dxfContents, svgContents) {
    return __awaiter(this, void 0, void 0, function () {
        var helper, previewSVG, warnings, _a, textsByColor, entitiesByColor, duplicates, svgObj, parser;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    helper = new Helper(dxfContents);
                    previewSVG = helper.toSVG();
                    warnings = [];
                    _a = categorize(helper.denormalised), textsByColor = _a.textsByColor, entitiesByColor = _a.entitiesByColor;
                    duplicates = checkForDuplicates(textsByColor);
                    if (duplicates && duplicates.length > 0) {
                        warnings.push({ term: "frameupload.dxfwarning.duplicate", data: { DUPLICATES: checkForDuplicates(textsByColor).join(" & ") } });
                    }
                    if (!svgContents) return [3 /*break*/, 2];
                    parser = new xml2js_1.default.Parser();
                    return [4 /*yield*/, parser.parseStringPromise(svgContents)];
                case 1:
                    svgObj = _b.sent();
                    _b.label = 2;
                case 2:
                    // create the parts just to make the warnings
                    createParts(textsByColor, entitiesByColor, svgObj, warnings);
                    return [2 /*return*/, { previewSVG: previewSVG, warnings: warnings }];
            }
        });
    });
}
exports.analyzeDXF = analyzeDXF;
function makeModelParts(dxfContents, svgContents) {
    return __awaiter(this, void 0, void 0, function () {
        var helper, _a, textsByColor, entitiesByColor, parser, svgObj, parts, options, convertedParts, bridgeMeas, hingeMeas, isLeftSide, fullMeas, combined, newBridgeMeas;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    helper = new Helper(dxfContents);
                    _a = categorize(helper.denormalised), textsByColor = _a.textsByColor, entitiesByColor = _a.entitiesByColor;
                    parser = new xml2js_1.default.Parser();
                    return [4 /*yield*/, parser.parseStringPromise(svgContents)];
                case 1:
                    svgObj = _b.sent();
                    parts = createParts(textsByColor, entitiesByColor, svgObj, []);
                    options = {
                        pointMatchingDistance: 0.05,
                        shallow: false,
                        unifyBeziers: true
                    };
                    convertedParts = {};
                    Object.keys(parts).forEach(function (key) {
                        var part = parts[key];
                        var chains = makerjs_1.default.model.findChains(part, options);
                        if (chains.length === 1) {
                            var model = makerjs_1.default.chain.toNewModel(chains[0], true);
                            convertedParts[key] = model;
                        }
                        else if (chains.length > 1) {
                            var modelMap = {};
                            chains.forEach(function (element, index) {
                                modelMap[key + "-" + index] = makerjs_1.default.chain.toNewModel(element, true);
                            });
                            convertedParts[key] = { models: modelMap };
                        }
                    });
                    bridgeMeas = makerjs_1.default.measure.modelExtents(convertedParts.bridge);
                    hingeMeas = makerjs_1.default.measure.modelExtents(convertedParts.hinge);
                    isLeftSide = hingeMeas.high[0] < bridgeMeas.low[0];
                    fullMeas = makerjs_1.default.measure.modelExtents({ models: convertedParts });
                    combined = { models: convertedParts, origin: makerjs_1.default.point.scale(fullMeas.low, -1) };
                    makerjs_1.default.model.originate(combined);
                    makerjs_1.default.model.zero(combined);
                    if (isLeftSide) {
                        // mirror the parts so the bridge is the part that starts at 0
                        Object.keys(combined.models).forEach(function (key) {
                            var model = combined.models[key];
                            combined.models[key] = makerjs_1.default.model.distort(model, -1, 1);
                        });
                        makerjs_1.default.model.zero(combined);
                        makerjs_1.default.model.originate(combined);
                    }
                    newBridgeMeas = makerjs_1.default.measure.modelExtents(combined.models.bridge);
                    makerjs_1.default.model.moveRelative(combined, [0, -newBridgeMeas.center[1]]);
                    makerjs_1.default.model.originate(combined);
                    return [2 /*return*/, combined.models];
            }
        });
    });
}
exports.makeModelParts = makeModelParts;
function convertToChained(model) {
    var options = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: false
    };
    var chains = makerjs_1.default.model.findChains(model, options);
    console.log("chains: ", chains);
    var chainedParts = {};
    chains.forEach(function (element, index) {
        chainedParts["chain_" + index] = makerjs_1.default.chain.toNewModel(element, true);
    });
    return { models: chainedParts };
}
function findConnectingLine(shape, pad) {
    // find the connection line in the shape
    var padTop = makerjs_1.default.measure.modelExtents(pad).high[1];
    var linesConnectedToTop = [];
    var findInShapeWalk = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                var line = wp.pathContext;
                var distToTop = Math.min(Math.abs(padTop - line.origin[1]), Math.abs(padTop - line.end[1]));
                if (distToTop < tol)
                    linesConnectedToTop.push({ line: line, route: wp.route });
            }
        }
    };
    makerjs_1.default.model.walk(shape, findInShapeWalk);
    if (linesConnectedToTop.length !== 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", linesConnectedToTop.length);
        return undefined;
    }
    var lineInShape = linesConnectedToTop[0];
    var topPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.origin : lineInShape.line.end;
    var bottomPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.end : lineInShape.line.origin;
    // find the lines that connect to the lineInShape in the pad
    linesConnectedToTop = [];
    var linesConnectedToBottom = [];
    var findLinesInPad = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                var line = wp.pathContext;
                var originToTop = makerjs_1.default.measure.pointDistance(topPoint, line.origin);
                var endTopTop = makerjs_1.default.measure.pointDistance(topPoint, line.end);
                var distToTop = Math.min(originToTop, endTopTop);
                var originToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.origin);
                var endToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.end);
                var distToBottom = Math.min(originToBottom, endToBottom);
                if (distToTop < tol)
                    linesConnectedToTop.push({
                        line: line, route: wp.route, isAtOrigin: originToTop < endTopTop
                    });
                if (distToBottom < tol)
                    linesConnectedToBottom.push({
                        line: line, route: wp.route, isAtOrigin: originToBottom < endToBottom
                    });
            }
        }
    };
    makerjs_1.default.model.walk(pad, findLinesInPad);
    return { lineInShape: lineInShape, padLinesTop: linesConnectedToTop, padLinesBottom: linesConnectedToBottom };
}
function clone(model) {
    return makerjs_1.default.cloneObject(model);
}
function lineInModel(model, lineInfo) {
    var runner = model;
    lineInfo.route.forEach(function (routeKey) {
        runner = runner[routeKey];
    });
    if (makerjs_1.default.isPathLine(runner)) {
        var line = runner;
        return line;
    }
    return undefined;
}
function setPointEqual(lineInfo, model, goalPoint) {
    var line = lineInModel(model, lineInfo);
    if (!line)
        return;
    if (lineInfo.isAtOrigin)
        line.origin = makerjs_1.default.point.clone(goalPoint);
    else
        line.end = makerjs_1.default.point.clone(goalPoint);
}
function combineModel(parts, bridgeSize, glasWidth, glasHeight, defaultSizes) {
    var m = makerjs_1.default.model;
    var t0 = performance.now();
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    var shape = clone(parts.shape);
    var pad = clone(parts.pad);
    var hinge = parts.hinge;
    var bridge = parts.bridge;
    var connectingLines = findConnectingLine(shape, pad);
    var bridgeMeas = makerjs_1.default.measure.modelExtents(bridge);
    var shapeMeas = makerjs_1.default.measure.modelExtents(shape);
    var padMeas = makerjs_1.default.measure.modelExtents(pad);
    var padMin = padMeas.low[0];
    // the amount the rightmost point of the pad is reaching into the shape
    var padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]];
    var bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize) / (2 * bridgeMeas.width);
    var bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize) / 2;
    var verticalFactor = glasHeight / defaultSizes.glasHeight;
    var horizontalFactor = glasWidth / defaultSizes.glasWidth;
    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor, verticalFactor);
    // scale shape and hinge around center of bridge
    m.moveRelative(shape, [-shapeMeas.low[0], 0]);
    m.originate(shape);
    // give it a little bit extra to overcome small glitches when combining
    var floatingPointSecFactor = 1.00003;
    shape = m.distort(shape, horizontalFactor * floatingPointSecFactor, verticalFactor);
    m.moveRelative(shape, [shapeMeas.low[0] - 0.5 * (floatingPointSecFactor - 1), 0]);
    hinge = m.distort(hinge, 1, verticalFactor);
    var hingeTranslation = shapeMeas.width * (horizontalFactor - 1);
    var padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)];
    m.moveRelative(shape, [bridgeXTranslation, 0]);
    m.moveRelative(hinge, [bridgeXTranslation + hingeTranslation, 0]);
    var totalPadTranslation = makerjs_1.default.point.add([bridgeXTranslation, 0], padTranslation);
    var padDiff = padMin + totalPadTranslation[0] - minPadX;
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin;
        totalPadTranslation[1] = totalPadTranslation[1] - padDiff * 0.4;
    }
    m.moveRelative(pad, totalPadTranslation);
    // connect the pads to the shape on the connecting line
    m.originate({ models: { shape: shape, pad: pad } });
    if (connectingLines) {
        var shapeLine = lineInModel(shape, connectingLines.lineInShape);
        if (shapeLine) {
            var topPoint_1 = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.origin : shapeLine.end;
            var bottomPoint_1 = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.end : shapeLine.origin;
            connectingLines.padLinesTop.forEach(function (lineInfo) { return setPointEqual(lineInfo, pad, topPoint_1); });
            connectingLines.padLinesBottom.forEach(function (lineInfo) { return setPointEqual(lineInfo, pad, bottomPoint_1); });
        }
        else {
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
        }
    }
    else {
        console.log("ERROR: Failed to find line that connects Pad and Shape!");
    }
    if (parts.shape_holes) {
        var holes_1 = clone(parts.shape_holes);
        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        if (holes_1.models) {
            Object.keys(holes_1.models).forEach(function (key) {
                if (!holes_1.models)
                    return;
                var hole = holes_1.models[key];
                // we scale the shape from the lower end
                var center = makerjs_1.default.point.subtract(makerjs_1.default.measure.modelExtents(hole).center, [shapeMeas.low[0], 0]);
                var scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor];
                var diff = makerjs_1.default.point.subtract(scaledCenter, center);
                m.moveRelative(hole, diff);
            });
        }
        m.moveRelative(holes_1, [bridgeXTranslation, 0]);
        shape = m.combineSubtraction(shape, holes_1);
    }
    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
    var bridgeAndShape = m.combine(bridge, shape, false, true, false, true);
    var bridgeShapeAndPads = m.combine(bridgeAndShape, pad, false, true, false, true);
    var fullSide = m.combine(bridgeShapeAndPads, hinge, false, true, false, true);
    var mirroredSide = m.mirror(fullSide, true, false);
    m.moveRelative(fullSide, [-0.0001, 0]);
    var fullFrame = m.combineUnion(fullSide, mirroredSide);
    var t1 = performance.now();
    console.log("Combining frame took " + (t1 - t0) + " ms.");
    return fullFrame;
}
exports.combineModel = combineModel;
