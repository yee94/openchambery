const START_MARK = 'yuri.session-switch.start';
const HIGHLIGHT_MARK = 'yuri.session-switch.highlight-painted';
const CONTENT_MARK = 'yuri.session-switch.content-committed';
const HIGHLIGHT_DATA_ATTRIBUTE = 'data-yuri-session-switch-highlight-ms';
const CONTENT_DATA_ATTRIBUTE = 'data-yuri-session-switch-content-ms';

const SESSION_SWITCH_HIGHLIGHT_MEASURE = 'yuri.session-switch.highlight-latency';
const SESSION_SWITCH_CONTENT_MEASURE = 'yuri.session-switch.content-latency';

const canMeasure = (): boolean => (
    typeof performance !== 'undefined'
    && typeof performance.mark === 'function'
    && typeof performance.measure === 'function'
);

const hasStartMark = (): boolean => (
    canMeasure() && performance.getEntriesByName(START_MARK, 'mark').length > 0
);

const exposeLatestDuration = (attribute: string, duration: number): void => {
    if (typeof document === 'undefined') {
        return;
    }
    document.documentElement.setAttribute(attribute, duration.toFixed(2));
};

export const beginSessionSwitchMeasure = (force = false): void => {
    if (!canMeasure()) {
        return;
    }
    if (
        !force
        && performance.getEntriesByName(START_MARK, 'mark').length > 0
        && performance.getEntriesByName(CONTENT_MARK, 'mark').length === 0
    ) {
        return;
    }
    performance.clearMarks(START_MARK);
    performance.clearMarks(HIGHLIGHT_MARK);
    performance.clearMarks(CONTENT_MARK);
    performance.clearMeasures(SESSION_SWITCH_HIGHLIGHT_MEASURE);
    performance.clearMeasures(SESSION_SWITCH_CONTENT_MEASURE);
    if (typeof document !== 'undefined') {
        document.documentElement.removeAttribute(HIGHLIGHT_DATA_ATTRIBUTE);
        document.documentElement.removeAttribute(CONTENT_DATA_ATTRIBUTE);
    }
    performance.mark(START_MARK);
};

export const markSessionSwitchHighlightPainted = (): void => {
    if (!hasStartMark()) {
        return;
    }
    performance.mark(HIGHLIGHT_MARK);
    performance.measure(SESSION_SWITCH_HIGHLIGHT_MEASURE, START_MARK, HIGHLIGHT_MARK);
    const measure = performance.getEntriesByName(SESSION_SWITCH_HIGHLIGHT_MEASURE, 'measure').at(-1);
    if (measure) {
        exposeLatestDuration(HIGHLIGHT_DATA_ATTRIBUTE, measure.duration);
    }
};

export const markSessionSwitchContentCommitted = (): void => {
    if (!hasStartMark()) {
        return;
    }
    performance.mark(CONTENT_MARK);
    performance.measure(SESSION_SWITCH_CONTENT_MEASURE, START_MARK, CONTENT_MARK);
    const measure = performance.getEntriesByName(SESSION_SWITCH_CONTENT_MEASURE, 'measure').at(-1);
    if (measure) {
        exposeLatestDuration(CONTENT_DATA_ATTRIBUTE, measure.duration);
    }
};
