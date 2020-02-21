"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const makerjs_1 = __importDefault(require("makerjs"));
const xml2js_1 = __importDefault(require("xml2js"));
// unfortunately dxf has no types
// import { Helper, entityToBoundsAndElement, colors } from 'dxf';
const { Helper, entityToBoundsAndElement, colors } = require('dxf');
const tol = 0.0001;
const minPadX = 0.2;
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
        return `#${rgbToHex(rgb[0])}${rgbToHex(rgb[1])}${rgbToHex(rgb[2])}`;
    }
}
function categorize(entities) {
    var textsByColor = {};
    var entitiesByColor = {};
    entities.forEach(entity => {
        if (entity.type === "MTEXT") {
            let existing = textsByColor[entity.colorNumber];
            if (existing) {
                existing.push(entity.string);
            }
            else {
                textsByColor[entity.colorNumber] = Array(entity.string);
            }
        }
        else {
            let existing = entitiesByColor[entity.colorNumber];
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
    let duplicateKey = Object.keys(textsByColor).find(key => textsByColor[key].length > 1);
    return duplicateKey ? textsByColor[duplicateKey].map(t => `"${t}"`) : [];
}
function modelFromPaths(paths) {
    let makerobjects = paths.map(pathData => {
        const pathModel = makerjs_1.default.importer.fromSVGPathData(pathData);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        const mirroredModel = makerjs_1.default.model.mirror(pathModel, false, true);
        makerjs_1.default.model.originate(mirroredModel);
        makerjs_1.default.model.simplify(mirroredModel);
        return mirroredModel;
    });
    let obj = makerobjects.reduce((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    let model = { models: obj };
    return model;
}
function modelFromCircles(circles) {
    let circlePaths = circles.map(circle => {
        let radius = parseFloat(circle.$.r);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        let center = [parseFloat(circle.$.cx), parseFloat(circle.$.cy)];
        return new makerjs_1.default.paths.Circle(center, radius);
    });
    let pathMap = circlePaths.reduce((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    return { paths: pathMap };
}
function createParts(textsByColor, entitiesByColor, svgObj, warnings) {
    var objectsByColor = {};
    Object.keys(entitiesByColor).forEach(color => {
        let paths = entitiesByColor[color].map(entity => {
            const { element } = entityToBoundsAndElement(entity);
            if (element.startsWith("<path d=") && element.endsWith(" />")) {
                let length = element.length;
                return element.substring(9, length - 9 - 5);
            }
            else {
                console.log(`entity ${entity.type} lead to an unusable svg of `, element);
                return undefined;
            }
        });
        objectsByColor[color] = modelFromPaths(paths);
    });
    let partNames = {
        bridge: ["bridge", "bruecke", "brücke"],
        shape: ["shape", "front", "frame", "shape_left", "shape_right"],
        hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
        pad: ["pad", "pad_left", "pad_right"]
    };
    var parts = {};
    Object.keys(partNames).forEach(part => {
        let names = partNames[part];
        let color = Object.keys(textsByColor).find(color => {
            let texts = textsByColor[color];
            return texts.find(text => names.includes(text.toLowerCase())) !== undefined;
        });
        if (!color) {
            warnings.push({ term: "frameupload.dxfwarning.missingAnnotation", data: { NAME: part } });
        }
        else {
            let object = objectsByColor[color];
            if (!object) {
                warnings.push({ term: "frameupload.dxfwarning.missingCurve", data: { NAME: part } });
            }
            else {
                if (svgObj && svgObj.svg && svgObj.svg.g.length > 0 && svgObj.svg.g[0].path) {
                    let firstGroup = svgObj.svg.g[0];
                    let paths = firstGroup.path;
                    let rgb = rgbToColorAttribute(colors[color]);
                    let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${rgb}`));
                    if (matchingPaths.length > 0) {
                        parts[part] = modelFromPaths(matchingPaths.map(path => path.$.d));
                    }
                    if (firstGroup.circle && firstGroup.circle.length > 0) {
                        let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${rgb}`));
                        if (part === "shape") {
                            parts[`${part}_holes`] = modelFromCircles(colorFittingCircles);
                        }
                        else {
                            console.log(`Unhandled circles for ${part}: `, firstGroup.circle);
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
async function analyzeDXF(dxfContents, svgContents) {
    const helper = new Helper(dxfContents);
    const previewSVG = helper.toSVG();
    var warnings = [];
    var { textsByColor, entitiesByColor } = categorize(helper.denormalised);
    let duplicates = checkForDuplicates(textsByColor);
    if (duplicates && duplicates.length > 0) {
        warnings.push({ term: "frameupload.dxfwarning.duplicate", data: { DUPLICATES: checkForDuplicates(textsByColor).join(" & ") } });
    }
    var svgObj;
    if (svgContents) {
        let parser = new xml2js_1.default.Parser();
        svgObj = await parser.parseStringPromise(svgContents);
    }
    // create the parts just to make the warnings
    createParts(textsByColor, entitiesByColor, svgObj, warnings);
    return { previewSVG: previewSVG, warnings: warnings };
}
exports.analyzeDXF = analyzeDXF;
async function makeModelParts(dxfContents, svgContents) {
    const helper = new Helper(dxfContents);
    const { textsByColor, entitiesByColor } = categorize(helper.denormalised);
    const parser = new xml2js_1.default.Parser();
    const svgObj = await parser.parseStringPromise(svgContents);
    const parts = createParts(textsByColor, entitiesByColor, svgObj, []);
    const options = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: true
    };
    var convertedParts = {};
    Object.keys(parts).forEach(key => {
        const part = parts[key];
        const chains = makerjs_1.default.model.findChains(part, options);
        if (chains.length === 1) {
            let model = makerjs_1.default.chain.toNewModel(chains[0], true);
            convertedParts[key] = model;
        }
        else if (chains.length > 1) {
            var modelMap = {};
            chains.forEach((element, index) => {
                modelMap[`${key}-${index}`] = makerjs_1.default.chain.toNewModel(element, true);
            });
            convertedParts[key] = { models: modelMap };
        }
    });
    let bridgeMeas = makerjs_1.default.measure.modelExtents(convertedParts.bridge);
    let hingeMeas = makerjs_1.default.measure.modelExtents(convertedParts.hinge);
    let isLeftSide = hingeMeas.high[0] < bridgeMeas.low[0];
    // move combined model to have origin [0, 0]
    let fullMeas = makerjs_1.default.measure.modelExtents({ models: convertedParts });
    let combined = { models: convertedParts, origin: makerjs_1.default.point.scale(fullMeas.low, -1) };
    makerjs_1.default.model.originate(combined);
    makerjs_1.default.model.zero(combined);
    if (isLeftSide) {
        // mirror the parts so the bridge is the part that starts at 0
        Object.keys(combined.models).forEach(key => {
            const model = combined.models[key];
            combined.models[key] = makerjs_1.default.model.distort(model, -1, 1);
        });
        makerjs_1.default.model.zero(combined);
        makerjs_1.default.model.originate(combined);
    }
    // move down so the vertical center line is 0
    let newBridgeMeas = makerjs_1.default.measure.modelExtents(combined.models.bridge);
    makerjs_1.default.model.moveRelative(combined, [0, -newBridgeMeas.center[1]]);
    makerjs_1.default.model.originate(combined);
    return combined.models;
}
exports.makeModelParts = makeModelParts;
function convertToChained(model) {
    const options = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: false
    };
    const chains = makerjs_1.default.model.findChains(model, options);
    console.log("chains: ", chains);
    var chainedParts = {};
    chains.forEach((element, index) => {
        chainedParts[`chain_${index}`] = makerjs_1.default.chain.toNewModel(element, true);
    });
    return { models: chainedParts };
}
function findConnectingLine(shape, pad) {
    // find the connection line in the shape
    let padTop = makerjs_1.default.measure.modelExtents(pad).high[1];
    var linesConnectedToTop = [];
    var findInShapeWalk = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                let line = wp.pathContext;
                let distToTop = Math.min(Math.abs(padTop - line.origin[1]), Math.abs(padTop - line.end[1]));
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
    let lineInShape = linesConnectedToTop[0];
    let topPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.origin : lineInShape.line.end;
    let bottomPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.end : lineInShape.line.origin;
    // find the lines that connect to the lineInShape in the pad
    linesConnectedToTop = [];
    var linesConnectedToBottom = [];
    var findLinesInPad = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                let line = wp.pathContext;
                let originToTop = makerjs_1.default.measure.pointDistance(topPoint, line.origin);
                let endTopTop = makerjs_1.default.measure.pointDistance(topPoint, line.end);
                let distToTop = Math.min(originToTop, endTopTop);
                let originToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.origin);
                let endToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.end);
                let distToBottom = Math.min(originToBottom, endToBottom);
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
    lineInfo.route.forEach(routeKey => {
        runner = runner[routeKey];
    });
    if (makerjs_1.default.isPathLine(runner)) {
        let line = runner;
        return line;
    }
    return undefined;
}
function setPointEqual(lineInfo, model, goalPoint) {
    let line = lineInModel(model, lineInfo);
    if (!line)
        return;
    if (lineInfo.isAtOrigin)
        line.origin = makerjs_1.default.point.clone(goalPoint);
    else
        line.end = makerjs_1.default.point.clone(goalPoint);
}
function combineModel(parts, bridgeSize, glasWidth, glasHeight, defaultSizes) {
    let m = makerjs_1.default.model;
    var t0 = performance.now();
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape);
    let pad = clone(parts.pad);
    let hinge = parts.hinge;
    var bridge = parts.bridge;
    let connectingLines = findConnectingLine(shape, pad);
    let bridgeMeas = makerjs_1.default.measure.modelExtents(bridge);
    let shapeMeas = makerjs_1.default.measure.modelExtents(shape);
    let padMeas = makerjs_1.default.measure.modelExtents(pad);
    let padMin = padMeas.low[0];
    // the amount the rightmost point of the pad is reaching into the shape
    let padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]];
    let bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize) / (2 * bridgeMeas.width);
    let bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize) / 2;
    let verticalFactor = glasHeight / defaultSizes.glasHeight;
    let horizontalFactor = glasWidth / defaultSizes.glasWidth;
    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor, verticalFactor);
    // scale shape and hinge around center of bridge
    m.moveRelative(shape, [-shapeMeas.low[0], 0]);
    m.originate(shape);
    // give it a little bit extra to overcome small glitches when combining
    const floatingPointSecFactor = 1.00003;
    shape = m.distort(shape, horizontalFactor * floatingPointSecFactor, verticalFactor);
    m.moveRelative(shape, [shapeMeas.low[0] - 0.5 * (floatingPointSecFactor - 1), 0]);
    hinge = m.distort(hinge, 1, verticalFactor);
    let hingeTranslation = shapeMeas.width * (horizontalFactor - 1);
    let padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)];
    m.moveRelative(shape, [bridgeXTranslation, 0]);
    m.moveRelative(hinge, [bridgeXTranslation + hingeTranslation, 0]);
    var totalPadTranslation = makerjs_1.default.point.add([bridgeXTranslation, 0], padTranslation);
    let padDiff = padMin + totalPadTranslation[0] - minPadX;
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin;
        totalPadTranslation[1] = totalPadTranslation[1] - padDiff * 0.4;
    }
    m.moveRelative(pad, totalPadTranslation);
    // connect the pads to the shape on the connecting line
    m.originate({ models: { shape: shape, pad: pad } });
    if (connectingLines) {
        let shapeLine = lineInModel(shape, connectingLines.lineInShape);
        if (shapeLine) {
            let topPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.origin : shapeLine.end;
            let bottomPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.end : shapeLine.origin;
            connectingLines.padLinesTop.forEach(lineInfo => setPointEqual(lineInfo, pad, topPoint));
            connectingLines.padLinesBottom.forEach(lineInfo => setPointEqual(lineInfo, pad, bottomPoint));
        }
        else {
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
        }
    }
    else {
        console.log("ERROR: Failed to find line that connects Pad and Shape!");
    }
    if (parts.shape_holes) {
        let holes = clone(parts.shape_holes);
        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        if (holes.models) {
            Object.keys(holes.models).forEach(key => {
                if (!holes.models)
                    return;
                let hole = holes.models[key];
                // we scale the shape from the lower end
                var center = makerjs_1.default.point.subtract(makerjs_1.default.measure.modelExtents(hole).center, [shapeMeas.low[0], 0]);
                let scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor];
                let diff = makerjs_1.default.point.subtract(scaledCenter, center);
                m.moveRelative(hole, diff);
            });
        }
        m.moveRelative(holes, [bridgeXTranslation, 0]);
        shape = m.combineSubtraction(shape, holes);
    }
    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
    let bridgeAndShape = m.combine(bridge, shape, false, true, false, true);
    let bridgeShapeAndPads = m.combine(bridgeAndShape, pad, false, true, false, true);
    var fullSide = m.combine(bridgeShapeAndPads, hinge, false, true, false, true);
    let mirroredSide = m.mirror(fullSide, true, false);
    m.moveRelative(fullSide, [-0.0001, 0]);
    let fullFrame = m.combineUnion(fullSide, mirroredSide);
    var t1 = performance.now();
    console.log("Combining frame took " + (t1 - t0) + " ms.");
    return fullFrame;
}
exports.combineModel = combineModel;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRFhGQW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEWEZBbmFseXplci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLHNEQUF1RDtBQUN2RCxvREFBNEI7QUFFNUIsaUNBQWlDO0FBQ2pDLGtFQUFrRTtBQUNsRSxNQUFNLEVBQUUsTUFBTSxFQUFFLHdCQUF3QixFQUFFLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUVwRSxNQUFNLEdBQUcsR0FBRyxNQUFNLENBQUE7QUFDbEIsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFBO0FBRW5CLElBQUksUUFBUSxHQUFHLFVBQVUsR0FBVztJQUNoQyxJQUFJLEdBQUcsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ25DLElBQUksR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7UUFDaEIsR0FBRyxHQUFHLEdBQUcsR0FBRyxHQUFHLENBQUM7S0FDbkI7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUMsQ0FBQztBQUVGLFNBQVMsbUJBQW1CLENBQUMsR0FBa0I7SUFDM0MsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtRQUNwRCxPQUFPLFVBQVUsQ0FBQztLQUNyQjtTQUFNO1FBQ0gsT0FBTyxJQUFJLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7S0FDdkU7QUFDTCxDQUFDO0FBMENELFNBQVMsVUFBVSxDQUFDLFFBQTBCO0lBQzFDLElBQUksWUFBWSxHQUFxQyxFQUFFLENBQUE7SUFDdkQsSUFBSSxlQUFlLEdBQXdDLEVBQUUsQ0FBQTtJQUU3RCxRQUFRLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFO1FBQ3RCLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUU7WUFDekIsSUFBSSxRQUFRLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQTtZQUMvQyxJQUFJLFFBQVEsRUFBRTtnQkFDVixRQUFRLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQTthQUMvQjtpQkFBTTtnQkFDSCxZQUFZLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUE7YUFDMUQ7U0FDSjthQUFNO1lBQ0gsSUFBSSxRQUFRLEdBQUcsZUFBZSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQTtZQUNsRCxJQUFJLFFBQVEsRUFBRTtnQkFDVixRQUFRLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFBO2FBQ3hCO2lCQUFNO2dCQUNILGVBQWUsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFBO2FBQ3REO1NBQ0o7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUNILE9BQU8sRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLGVBQWUsRUFBRSxlQUFlLEVBQUUsQ0FBQTtBQUMzRSxDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxZQUE4QztJQUN0RSxJQUFJLFlBQVksR0FBSSxNQUFNLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBc0MsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFBO0lBQzVILE9BQU8sWUFBWSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUE7QUFDNUUsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEtBQWU7SUFDbkMsSUFBSSxZQUFZLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsRUFBRTtRQUNwQyxNQUFNLFNBQVMsR0FBRyxpQkFBTyxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLENBQUE7UUFDNUQsbUZBQW1GO1FBQ25GLE1BQU0sYUFBYSxHQUFHLGlCQUFPLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFBO1FBRWxFLGlCQUFPLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQTtRQUN0QyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUE7UUFDckMsT0FBTyxhQUFhLENBQUE7SUFDeEIsQ0FBQyxDQUFDLENBQUE7SUFDRixJQUFJLEdBQUcsR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFZLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUNyRCxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxDQUFDO1FBQ2IsT0FBTyxHQUFHLENBQUM7SUFDZixDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDUCxJQUFJLEtBQUssR0FBRyxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsQ0FBQTtJQUUzQixPQUFPLEtBQUssQ0FBQTtBQUNoQixDQUFDO0FBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxPQUFvQjtJQUMxQyxJQUFJLFdBQVcsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFO1FBQ25DLElBQUksTUFBTSxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQ25DLG1GQUFtRjtRQUNuRixJQUFJLE1BQU0sR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7UUFDL0QsT0FBTyxJQUFJLGlCQUFPLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUE7SUFDbkQsQ0FBQyxDQUFDLENBQUE7SUFDRixJQUFJLE9BQU8sR0FBRyxXQUFXLENBQUMsTUFBTSxDQUFXLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUN2RCxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxDQUFDO1FBQ2IsT0FBTyxHQUFHLENBQUM7SUFDZixDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFFUCxPQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxDQUFBO0FBQzdCLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FDaEIsWUFBZ0QsRUFDaEQsZUFBc0QsRUFDdEQsTUFBVyxFQUNYLFFBQXdCO0lBRXhCLElBQUksY0FBYyxHQUFzQyxFQUFFLENBQUE7SUFFMUQsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUU7UUFDekMsSUFBSSxLQUFLLEdBQWEsZUFBZSxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRTtZQUN0RCxNQUFNLEVBQUUsT0FBTyxFQUFFLEdBQUcsd0JBQXdCLENBQUMsTUFBTSxDQUFDLENBQUE7WUFDcEQsSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUU7Z0JBQzNELElBQUksTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUE7Z0JBQzNCLE9BQU8sT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQTthQUM5QztpQkFBTTtnQkFDSCxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsTUFBTSxDQUFDLElBQUksOEJBQThCLEVBQUUsT0FBTyxDQUFDLENBQUE7Z0JBQ3pFLE9BQU8sU0FBUyxDQUFBO2FBQ25CO1FBQ0wsQ0FBQyxDQUFDLENBQUE7UUFFRixjQUFjLENBQUMsS0FBSyxDQUFDLEdBQUcsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ2pELENBQUMsQ0FBQyxDQUFBO0lBRUYsSUFBSSxTQUFTLEdBQStCO1FBQ3hDLE1BQU0sRUFBRSxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsUUFBUSxDQUFDO1FBQ3ZDLEtBQUssRUFBRSxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFlBQVksRUFBRSxhQUFhLENBQUM7UUFDL0QsS0FBSyxFQUFFLENBQUMsT0FBTyxFQUFFLFlBQVksRUFBRSxhQUFhLEVBQUUsT0FBTyxDQUFDO1FBQ3RELEdBQUcsRUFBRSxDQUFDLEtBQUssRUFBRSxVQUFVLEVBQUUsV0FBVyxDQUFDO0tBQ3hDLENBQUE7SUFFRCxJQUFJLEtBQUssR0FBc0MsRUFBRSxDQUFBO0lBQ2pELE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQ2xDLElBQUksS0FBSyxHQUFhLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQTtRQUNyQyxJQUFJLEtBQUssR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUMvQyxJQUFJLEtBQUssR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUE7WUFDL0IsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxLQUFLLFNBQVMsQ0FBQTtRQUMvRSxDQUFDLENBQUMsQ0FBQTtRQUNGLElBQUksQ0FBQyxLQUFLLEVBQUU7WUFDUixRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLDBDQUEwQyxFQUFFLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUE7U0FDNUY7YUFBTTtZQUNILElBQUksTUFBTSxHQUFHLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtZQUNsQyxJQUFJLENBQUMsTUFBTSxFQUFFO2dCQUNULFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUscUNBQXFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQTthQUN2RjtpQkFBTTtnQkFDSCxJQUFJLE1BQU0sSUFBSSxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFO29CQUN6RSxJQUFJLFVBQVUsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQTtvQkFDaEMsSUFBSSxLQUFLLEdBQUcsVUFBVSxDQUFDLElBQUksQ0FBQTtvQkFDM0IsSUFBSSxHQUFHLEdBQUcsbUJBQW1CLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUE7b0JBQzVDLElBQUksYUFBYSxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsVUFBVSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUE7b0JBQ3ZILElBQUksYUFBYSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7d0JBQzFCLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxjQUFjLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQTtxQkFDcEU7b0JBQ0QsSUFBSSxVQUFVLENBQUMsTUFBTSxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTt3QkFDbkQsSUFBSSxtQkFBbUIsR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxVQUFVLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQTt3QkFDOUYsSUFBSSxJQUFJLEtBQUssT0FBTyxFQUFFOzRCQUNsQixLQUFLLENBQUMsR0FBRyxJQUFJLFFBQVEsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLG1CQUFtQixDQUFDLENBQUE7eUJBQ2pFOzZCQUFNOzRCQUNILE9BQU8sQ0FBQyxHQUFHLENBQUMseUJBQXlCLElBQUksSUFBSSxFQUFFLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQTt5QkFDcEU7cUJBQ0o7aUJBQ0o7YUFDSjtTQUNKO0lBQ0wsQ0FBQyxDQUFDLENBQUE7SUFFRixPQUFPLEtBQUssQ0FBQTtBQUNoQixDQUFDO0FBT0Q7Ozs7Ozs7R0FPRztBQUNJLEtBQUssVUFBVSxVQUFVLENBQUMsV0FBbUIsRUFBRSxXQUFtQjtJQUNyRSxNQUFNLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQTtJQUN0QyxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUE7SUFFakMsSUFBSSxRQUFRLEdBQUcsRUFBRSxDQUFBO0lBQ2pCLElBQUksRUFBRSxZQUFZLEVBQUUsZUFBZSxFQUFFLEdBQUcsVUFBVSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQTtJQUV2RSxJQUFJLFVBQVUsR0FBRyxrQkFBa0IsQ0FBQyxZQUFZLENBQUMsQ0FBQTtJQUNqRCxJQUFJLFVBQVUsSUFBSSxVQUFVLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtRQUNyQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLGtDQUFrQyxFQUFFLElBQUksRUFBRSxFQUFFLFVBQVUsRUFBRSxrQkFBa0IsQ0FBQyxZQUFZLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBQyxDQUFDLENBQUE7S0FDakk7SUFFRCxJQUFJLE1BQU0sQ0FBQTtJQUNWLElBQUksV0FBVyxFQUFFO1FBQ2IsSUFBSSxNQUFNLEdBQUcsSUFBSSxnQkFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2pDLE1BQU0sR0FBRyxNQUFNLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxXQUFXLENBQUMsQ0FBQTtLQUN4RDtJQUVELDZDQUE2QztJQUM3QyxXQUFXLENBQUMsWUFBWSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUE7SUFFNUQsT0FBTyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxDQUFBO0FBQ3pELENBQUM7QUF0QkQsZ0NBc0JDO0FBRU0sS0FBSyxVQUFVLGNBQWMsQ0FDaEMsV0FBbUIsRUFDbkIsV0FBbUI7SUFFbkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUE7SUFFdEMsTUFBTSxFQUFFLFlBQVksRUFBRSxlQUFlLEVBQUUsR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFBO0lBRXpFLE1BQU0sTUFBTSxHQUFHLElBQUksZ0JBQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztJQUNuQyxNQUFNLE1BQU0sR0FBRyxNQUFNLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxXQUFXLENBQUMsQ0FBQTtJQUMzRCxNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsWUFBWSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUE7SUFFcEUsTUFBTSxPQUFPLEdBQStCO1FBQ3hDLHFCQUFxQixFQUFFLElBQUk7UUFDM0IsT0FBTyxFQUFFLEtBQUs7UUFDZCxZQUFZLEVBQUUsSUFBSTtLQUNyQixDQUFBO0lBRUQsSUFBSSxjQUFjLEdBQXVDLEVBQUUsQ0FBQTtJQUMzRCxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRTtRQUM3QixNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7UUFDdkIsTUFBTSxNQUFNLEdBQUcsaUJBQU8sQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxPQUFPLENBQXFCLENBQUE7UUFDMUUsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRTtZQUNyQixJQUFJLEtBQUssR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFBO1lBQ3JELGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUE7U0FDOUI7YUFBTSxJQUFJLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO1lBQzFCLElBQUksUUFBUSxHQUF1QyxFQUFFLENBQUE7WUFDckQsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsRUFBRTtnQkFDOUIsUUFBUSxDQUFDLEdBQUcsR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDLEdBQUcsaUJBQU8sQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQTtZQUN6RSxDQUFDLENBQUMsQ0FBQTtZQUNGLGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQTtTQUM3QztJQUNMLENBQUMsQ0FBQyxDQUFBO0lBRUYsSUFBSSxVQUFVLEdBQUcsaUJBQU8sQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUNwRSxJQUFJLFNBQVMsR0FBRyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ2xFLElBQUksVUFBVSxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUV0RCw0Q0FBNEM7SUFDNUMsSUFBSSxRQUFRLEdBQUcsaUJBQU8sQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxDQUFDLENBQUE7SUFDdkUsSUFBSSxRQUFRLEdBQUcsRUFBRSxNQUFNLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxpQkFBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUE7SUFDeEYsaUJBQU8sQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO0lBQ2pDLGlCQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQTtJQUU1QixJQUFJLFVBQVUsRUFBRTtRQUNaLDhEQUE4RDtRQUM5RCxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUU7WUFDdkMsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQTtZQUNsQyxRQUFRLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLGlCQUFPLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7UUFDOUQsQ0FBQyxDQUFDLENBQUE7UUFDRixpQkFBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUE7UUFDNUIsaUJBQU8sQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFBO0tBQ3BDO0lBRUQsNkNBQTZDO0lBQzdDLElBQUksYUFBYSxHQUFHLGlCQUFPLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFBO0lBQ3hFLGlCQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUNuRSxpQkFBTyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUE7SUFFakMsT0FBTyxRQUFRLENBQUMsTUFBTSxDQUFBO0FBQzFCLENBQUM7QUE1REQsd0NBNERDO0FBUUQsU0FBUyxnQkFBZ0IsQ0FBQyxLQUFxQjtJQUMzQyxNQUFNLE9BQU8sR0FBK0I7UUFDeEMscUJBQXFCLEVBQUUsSUFBSTtRQUMzQixPQUFPLEVBQUUsS0FBSztRQUNkLFlBQVksRUFBRSxLQUFLO0tBQ3RCLENBQUE7SUFFRCxNQUFNLE1BQU0sR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBcUIsQ0FBQTtJQUUzRSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxNQUFNLENBQUMsQ0FBQTtJQUUvQixJQUFJLFlBQVksR0FBdUIsRUFBRSxDQUFBO0lBQ3pDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDOUIsWUFBWSxDQUFDLFNBQVMsS0FBSyxFQUFFLENBQUMsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFBO0lBQzVFLENBQUMsQ0FBQyxDQUFBO0lBRUYsT0FBTyxFQUFFLE1BQU0sRUFBRSxZQUFZLEVBQUUsQ0FBQTtBQUNuQyxDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxLQUFxQixFQUFFLEdBQW1CO0lBRWxFLHdDQUF3QztJQUN4QyxJQUFJLE1BQU0sR0FBRyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ3RELElBQUksbUJBQW1CLEdBQWUsRUFBRSxDQUFBO0lBQ3hDLElBQUksZUFBZSxHQUF5QjtRQUN4QyxNQUFNLEVBQUUsVUFBVSxFQUFFO1lBQ2hCLElBQUksaUJBQU8sQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFO2dCQUNwQyxJQUFJLElBQUksR0FBRyxFQUFFLENBQUMsV0FBZ0MsQ0FBQTtnQkFDOUMsSUFBSSxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7Z0JBQzNGLElBQUksU0FBUyxHQUFHLEdBQUc7b0JBQUcsbUJBQW1CLENBQUMsSUFBSSxDQUFDLEVBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUE7YUFDakY7UUFDTCxDQUFDO0tBQ0osQ0FBQTtJQUNELGlCQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsZUFBZSxDQUFDLENBQUE7SUFDMUMsSUFBSSxtQkFBbUIsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO1FBQ2xDLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0ZBQWtGLEVBQUUsbUJBQW1CLENBQUMsTUFBTSxDQUFDLENBQUE7UUFDM0gsT0FBTyxTQUFTLENBQUE7S0FDbkI7SUFDRCxJQUFJLFdBQVcsR0FBRyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUN4QyxJQUFJLFFBQVEsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFBO0lBQ3BILElBQUksV0FBVyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUE7SUFFeEgsNERBQTREO0lBQzVELG1CQUFtQixHQUFHLEVBQUUsQ0FBQTtJQUN4QixJQUFJLHNCQUFzQixHQUFlLEVBQUUsQ0FBQTtJQUMzQyxJQUFJLGNBQWMsR0FBeUI7UUFDdkMsTUFBTSxFQUFFLFVBQVUsRUFBRTtZQUNoQixJQUFJLGlCQUFPLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsRUFBRTtnQkFDcEMsSUFBSSxJQUFJLEdBQUcsRUFBRSxDQUFDLFdBQWdDLENBQUE7Z0JBQzlDLElBQUksV0FBVyxHQUFHLGlCQUFPLENBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFBO2dCQUN0RSxJQUFJLFNBQVMsR0FBRyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQTtnQkFDakUsSUFBSSxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBRSxXQUFXLEVBQUUsU0FBUyxDQUFDLENBQUE7Z0JBQ2pELElBQUksY0FBYyxHQUFHLGlCQUFPLENBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFBO2dCQUM1RSxJQUFJLFdBQVcsR0FBRyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQTtnQkFDdEUsSUFBSSxZQUFZLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxjQUFjLEVBQUUsV0FBVyxDQUFDLENBQUE7Z0JBQ3hELElBQUksU0FBUyxHQUFHLEdBQUc7b0JBQUUsbUJBQW1CLENBQUMsSUFBSSxDQUFDO3dCQUMxQyxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxXQUFXLEdBQUcsU0FBUztxQkFDbkUsQ0FBQyxDQUFBO2dCQUNGLElBQUksWUFBWSxHQUFHLEdBQUc7b0JBQUUsc0JBQXNCLENBQUMsSUFBSSxDQUFDO3dCQUNoRCxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxjQUFjLEdBQUcsV0FBVztxQkFDeEUsQ0FBQyxDQUFBO2FBQ0w7UUFDTCxDQUFDO0tBQ0osQ0FBQTtJQUNELGlCQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLENBQUE7SUFDdkMsT0FBTyxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLG1CQUFtQixFQUFFLGNBQWMsRUFBRSxzQkFBc0IsRUFBRSxDQUFBO0FBQ2pILENBQUM7QUFFRCxTQUFTLEtBQUssQ0FBQyxLQUFxQjtJQUNoQyxPQUFPLGlCQUFPLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBQ3JDLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxLQUFxQixFQUFFLFFBQWtCO0lBQzFELElBQUksTUFBTSxHQUFHLEtBQVksQ0FBQTtJQUN6QixRQUFRLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBRSxRQUFRLENBQUMsRUFBRTtRQUMvQixNQUFNLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBUSxDQUFBO0lBQ3BDLENBQUMsQ0FBQyxDQUFBO0lBQ0YsSUFBSSxpQkFBTyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsRUFBRTtRQUM1QixJQUFJLElBQUksR0FBRyxNQUEyQixDQUFBO1FBQ3RDLE9BQU8sSUFBSSxDQUFBO0tBQ2Q7SUFDRCxPQUFPLFNBQVMsQ0FBQTtBQUNwQixDQUFDO0FBRUQsU0FBUyxhQUFhLENBQUMsUUFBa0IsRUFBRSxLQUFxQixFQUFFLFNBQXlCO0lBQ3ZGLElBQUksSUFBSSxHQUFHLFdBQVcsQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUE7SUFDdkMsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFNO0lBQ2pCLElBQUksUUFBUSxDQUFDLFVBQVU7UUFBRSxJQUFJLENBQUMsTUFBTSxHQUFHLGlCQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQTs7UUFDaEUsSUFBSSxDQUFDLEdBQUcsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7QUFDbEQsQ0FBQztBQUVELFNBQWdCLFlBQVksQ0FDeEIsS0FBd0IsRUFDeEIsVUFBa0IsRUFDbEIsU0FBaUIsRUFDakIsVUFBa0IsRUFDbEIsWUFBNEI7SUFFNUIsSUFBSSxDQUFDLEdBQUcsaUJBQU8sQ0FBQyxLQUFLLENBQUE7SUFFckIsSUFBSSxFQUFFLEdBQUcsV0FBVyxDQUFDLEdBQUcsRUFBRSxDQUFDO0lBRTNCLDBHQUEwRztJQUMxRyxJQUFJLEtBQUssR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQzlCLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDMUIsSUFBSSxLQUFLLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQTtJQUN2QixJQUFJLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFBO0lBRXpCLElBQUksZUFBZSxHQUFHLGtCQUFrQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQTtJQUVwRCxJQUFJLFVBQVUsR0FBRyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUE7SUFDckQsSUFBSSxTQUFTLEdBQUcsaUJBQU8sQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ25ELElBQUksT0FBTyxHQUFHLGlCQUFPLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQTtJQUMvQyxJQUFJLE1BQU0sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQzNCLHVFQUF1RTtJQUN2RSxJQUFJLFFBQVEsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFFcEUsSUFBSSxZQUFZLEdBQUcsQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUMsR0FBQyxDQUFDLENBQUMsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUE7SUFDcEYsSUFBSSxrQkFBa0IsR0FBRyxDQUFDLFVBQVUsR0FBRyxZQUFZLENBQUMsVUFBVSxDQUFDLEdBQUMsQ0FBQyxDQUFBO0lBQ2pFLElBQUksY0FBYyxHQUFHLFVBQVUsR0FBRyxZQUFZLENBQUMsVUFBVSxDQUFBO0lBQ3pELElBQUksZ0JBQWdCLEdBQUcsU0FBUyxHQUFHLFlBQVksQ0FBQyxTQUFTLENBQUE7SUFFekQsNkJBQTZCO0lBQzdCLE1BQU0sR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxZQUFZLEVBQUUsY0FBYyxDQUFDLENBQUE7SUFFeEQsZ0RBQWdEO0lBQ2hELENBQUMsQ0FBQyxZQUFZLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDN0MsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtJQUNsQix1RUFBdUU7SUFDdkUsTUFBTSxzQkFBc0IsR0FBRyxPQUFPLENBQUE7SUFDdEMsS0FBSyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLGdCQUFnQixHQUFHLHNCQUFzQixFQUFFLGNBQWMsQ0FBQyxDQUFBO0lBQ25GLENBQUMsQ0FBQyxZQUFZLENBQUMsS0FBSyxFQUFFLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxzQkFBc0IsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ2pGLEtBQUssR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxDQUFDLEVBQUUsY0FBYyxDQUFDLENBQUE7SUFFM0MsSUFBSSxnQkFBZ0IsR0FBRyxTQUFTLENBQUMsS0FBSyxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsQ0FBQyxDQUFDLENBQUE7SUFDL0QsSUFBSSxjQUFjLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsR0FBRyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxjQUFjLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUMvRixDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxDQUFDLGtCQUFrQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDOUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxLQUFLLEVBQUUsQ0FBQyxrQkFBa0IsR0FBRyxnQkFBZ0IsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ2pFLElBQUksbUJBQW1CLEdBQUcsaUJBQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsa0JBQWtCLEVBQUUsQ0FBQyxDQUFDLEVBQUUsY0FBYyxDQUFDLENBQUE7SUFDcEYsSUFBSSxPQUFPLEdBQUcsTUFBTSxHQUFHLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQTtJQUN2RCxJQUFJLE9BQU8sR0FBRyxDQUFDLEVBQUU7UUFDYixtQkFBbUIsQ0FBQyxDQUFDLENBQUMsR0FBRyxPQUFPLEdBQUcsTUFBTSxDQUFBO1FBQ3pDLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxHQUFHLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxHQUFHLE9BQU8sR0FBRyxHQUFHLENBQUE7S0FDbEU7SUFDRCxDQUFDLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxtQkFBbUIsQ0FBQyxDQUFBO0lBRXhDLHVEQUF1RDtJQUN2RCxDQUFDLENBQUMsU0FBUyxDQUFDLEVBQUMsTUFBTSxFQUFFLEVBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFDLEVBQUMsQ0FBQyxDQUFBO0lBQy9DLElBQUksZUFBZSxFQUFFO1FBQ2pCLElBQUksU0FBUyxHQUFHLFdBQVcsQ0FBQyxLQUFLLEVBQUUsZUFBZSxDQUFDLFdBQVcsQ0FBQyxDQUFBO1FBQy9ELElBQUksU0FBUyxFQUFFO1lBQ1gsSUFBSSxRQUFRLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFBO1lBQ3hGLElBQUksV0FBVyxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUUsU0FBUyxDQUFDLE1BQU0sQ0FBQTtZQUM1RixlQUFlLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUE7WUFDdkYsZUFBZSxDQUFDLGNBQWMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFBO1NBQ2hHO2FBQU07WUFDSCxPQUFPLENBQUMsR0FBRyxDQUFDLDZGQUE2RixDQUFDLENBQUE7U0FDN0c7S0FDSjtTQUFNO1FBQ0gsT0FBTyxDQUFDLEdBQUcsQ0FBQyx5REFBeUQsQ0FBQyxDQUFBO0tBQ3pFO0lBRUQsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFO1FBQ25CLElBQUksS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUE7UUFFcEMscURBQXFEO1FBQ3JELHVGQUF1RjtRQUN2RixJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUU7WUFDZCxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUU7Z0JBQ3BDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTTtvQkFBRSxPQUFNO2dCQUN6QixJQUFJLElBQUksR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFBO2dCQUM1Qix3Q0FBd0M7Z0JBQ3hDLElBQUksTUFBTSxHQUFHLGlCQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxpQkFBTyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFBO2dCQUNyRyxJQUFJLFlBQVksR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxnQkFBZ0IsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsY0FBYyxDQUFDLENBQUE7Z0JBQzdFLElBQUksSUFBSSxHQUFHLGlCQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDLENBQUE7Z0JBQ3ZELENBQUMsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFBO1lBQzlCLENBQUMsQ0FBQyxDQUFBO1NBQ0w7UUFFRCxDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxDQUFDLGtCQUFrQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDOUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUE7S0FDN0M7SUFFRCxrQ0FBa0M7SUFDbEMsK0NBQStDO0lBQy9DLElBQUksY0FBYyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQTtJQUN2RSxJQUFJLGtCQUFrQixHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQTtJQUNqRixJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLGtCQUFrQixFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQTtJQUM3RSxJQUFJLFlBQVksR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUE7SUFDbEQsQ0FBQyxDQUFDLFlBQVksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ3RDLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQyxZQUFZLENBQUMsUUFBUSxFQUFFLFlBQVksQ0FBQyxDQUFBO0lBRXRELElBQUksRUFBRSxHQUFHLFdBQVcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUMzQixPQUFPLENBQUMsR0FBRyxDQUFDLHVCQUF1QixHQUFHLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDO0lBRTFELE9BQU8sU0FBUyxDQUFBO0FBQ3BCLENBQUM7QUF6R0Qsb0NBeUdDIn0=