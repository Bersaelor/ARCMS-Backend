"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const makerjs_1 = __importDefault(require("makerjs"));
const xml2js_1 = __importDefault(require("xml2js"));
const tol = 0.0001;
const minPadX = 0.2;
const partNames = {
    bridge: ["bridge", "bruecke", "brücke"],
    shape: ["shape", "front", "frame", "shape_left", "shape_right"],
    hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
    pad: ["pad", "pad_left", "pad_right"]
};
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
function createParts(part2ColorMap, svgObj) {
    if (!svgObj || !svgObj.svg || svgObj.svg.g.length < 1 || !svgObj.svg.g[0].path) {
        console.log("SvgObj is missing key svg properties!");
        return {};
    }
    var parts = {};
    Object.keys(partNames).forEach(part => {
        let color = part2ColorMap[part];
        if (color) {
            let firstGroup = svgObj.svg.g[0];
            let paths = firstGroup.path;
            let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${color}`));
            if (matchingPaths.length > 0) {
                parts[part] = modelFromPaths(matchingPaths.map(path => path.$.d));
            }
            if (firstGroup.circle && firstGroup.circle.length > 0) {
                let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${color}`));
                if (part === "shape") {
                    parts[`${part}_holes`] = modelFromCircles(colorFittingCircles);
                }
                else {
                    console.log(`Unhandled circles for ${part}: `, firstGroup.circle);
                }
            }
        }
    });
    return parts;
}
async function makeModelParts(part2ColorMap, svgContents) {
    const parser = new xml2js_1.default.Parser();
    const svgObj = await parser.parseStringPromise(svgContents);
    const parts = createParts(part2ColorMap, svgObj);
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
    let shapeMeas = makerjs_1.default.measure.modelExtents(convertedParts.shape);
    let isLeftSide = shapeMeas.center[0] < bridgeMeas.center[0];
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
function findConnectingLine(shape, pad) {
    var warnings = [];
    // find the connection line in the shape
    let padMax = makerjs_1.default.measure.modelExtents(pad).high[0];
    var linesConnectedToPadMax = [];
    var findInShapeWalk = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                let line = wp.pathContext;
                let distToMax = Math.min(Math.abs(padMax - line.origin[0]), Math.abs(padMax - line.end[0]));
                if (distToMax < tol)
                    linesConnectedToPadMax.push({ line: line, route: wp.route });
            }
        }
    };
    makerjs_1.default.model.walk(shape, findInShapeWalk);
    if (linesConnectedToPadMax.length !== 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", linesConnectedToPadMax.length);
        return { connectingLines: undefined, warnings: warnings };
    }
    let lineInShape = linesConnectedToPadMax[0];
    let topPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.origin : lineInShape.line.end;
    let bottomPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.end : lineInShape.line.origin;
    // find the lines that connect to the lineInShape in the pad
    linesConnectedToPadMax = [];
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
                    linesConnectedToPadMax.push({
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
    return {
        connectingLines: { lineInShape: lineInShape, padLinesTop: linesConnectedToPadMax, padLinesBottom: linesConnectedToBottom },
        warnings: warnings
    };
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
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape);
    let pad = clone(parts.pad);
    let hinge = parts.hinge;
    var bridge = parts.bridge;
    let { connectingLines, warnings } = findConnectingLine(shape, pad);
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
    if (hinge)
        hinge = m.distort(hinge, 1, verticalFactor);
    let hingeTranslation = shapeMeas.width * (horizontalFactor - 1);
    let padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)];
    m.moveRelative(shape, [bridgeXTranslation, 0]);
    if (hinge)
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
            warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} });
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
        }
    }
    else {
        warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} });
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
    return { model: fullFrame, warnings: warnings };
}
exports.combineModel = combineModel;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRFhGQW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEWEZBbmFseXplci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLHNEQUF1RDtBQUN2RCxvREFBNEI7QUFFNUIsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFBO0FBQ2xCLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQTtBQUVuQixNQUFNLFNBQVMsR0FBK0I7SUFDMUMsTUFBTSxFQUFFLENBQUMsUUFBUSxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUM7SUFDdkMsS0FBSyxFQUFFLENBQUMsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsQ0FBQztJQUMvRCxLQUFLLEVBQUUsQ0FBQyxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUM7SUFDdEQsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxXQUFXLENBQUM7Q0FDeEMsQ0FBQTtBQW9DRCxTQUFTLGNBQWMsQ0FBQyxLQUFlO0lBQ25DLElBQUksWUFBWSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDcEMsTUFBTSxTQUFTLEdBQUcsaUJBQU8sQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxDQUFBO1FBQzVELG1GQUFtRjtRQUNuRixNQUFNLGFBQWEsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQTtRQUVsRSxpQkFBTyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDLENBQUE7UUFDdEMsaUJBQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFBO1FBQ3JDLE9BQU8sYUFBYSxDQUFBO0lBQ3hCLENBQUMsQ0FBQyxDQUFBO0lBQ0YsSUFBSSxHQUFHLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBWSxD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