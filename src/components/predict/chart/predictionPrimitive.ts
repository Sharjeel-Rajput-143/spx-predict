import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

interface Range {
  from: Time;
  to: Time;
}

/**
 * Draws a subtle full-height background band between two time coordinates -
 * used to highlight the candle(s) that make up the current prediction
 * window, independent of whatever timeframe the chart itself is showing.
 */
class HighlightRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _range: Range | null,
    private _chart: IChartApi | null,
    private _color: string,
  ) {}

  draw() {}

  drawBackground(target: CanvasRenderingTarget2D) {
    if (!this._range || !this._chart) return;
    const ts = this._chart.timeScale();
    const x1 = ts.timeToCoordinate(this._range.from);
    const x2 = ts.timeToCoordinate(this._range.to);
    if (x1 == null || x2 == null) return;
    const color = this._color;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const left = Math.min(x1, x2);
      const width = Math.max(1, Math.abs(x2 - x1));
      context.fillStyle = color;
      context.fillRect(left, 0, width, mediaSize.height);
    });
  }
}

class HighlightPaneView implements IPrimitivePaneView {
  constructor(private _source: PredictionWindowPrimitive) {}
  renderer() {
    return new HighlightRenderer(this._source.range, this._source.chart, this._source.color);
  }
}

export class PredictionWindowPrimitive implements ISeriesPrimitive<Time> {
  range: Range | null = null;
  chart: IChartApi | null = null;
  color: string;
  private _paneViews: HighlightPaneView[];
  private _requestUpdate?: () => void;

  constructor(color: string) {
    this.color = color;
    this._paneViews = [new HighlightPaneView(this)];
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
  }

  updateAllViews() {}

  paneViews() {
    return this._paneViews;
  }

  setRange(range: Range | null) {
    this.range = range;
    this._requestUpdate?.();
  }
}
