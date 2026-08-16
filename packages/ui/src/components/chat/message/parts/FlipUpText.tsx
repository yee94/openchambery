import React from 'react';
import { useEvent } from '@reactuses/core';
import { cn } from '@/lib/utils';

export const FlipUpText: React.FC<{
    text: string;
    active: boolean;
    className?: string;
}> = ({ text, active, className }) => {
    const previousTextRef = React.useRef(text);
    const [displayed, setDisplayed] = React.useState(text);
    const [outgoing, setOutgoing] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (text === previousTextRef.current) {
            return;
        }
        const previous = previousTextRef.current;
        previousTextRef.current = text;
        if (!active || previous.length === 0) {
            setOutgoing(null);
            setDisplayed(text);
            return;
        }
        setOutgoing(previous);
        setDisplayed(text);
    }, [active, text]);

    const handleAnimationEnd = useEvent(() => {
        setOutgoing(null);
    });

    return (
        <span className={cn('oc-summary-flip-viewport relative block h-5 min-h-0 w-full min-w-0 max-w-full overflow-hidden sm:h-6', className)}>
            <span className={cn('block h-full min-w-0 truncate leading-5 sm:leading-6', outgoing && 'invisible')}>{displayed}</span>
            {outgoing ? (
                <span className="oc-summary-flip-stage absolute inset-0 block overflow-hidden">
                    <span className="oc-summary-flip-out absolute inset-x-0 top-0 block h-full truncate" aria-hidden="true">
                        {outgoing}
                    </span>
                    <span
                        className="oc-summary-flip-in absolute inset-x-0 top-0 block h-full truncate"
                        onAnimationEnd={handleAnimationEnd}
                    >
                        {displayed}
                    </span>
                </span>
            ) : null}
        </span>
    );
};
