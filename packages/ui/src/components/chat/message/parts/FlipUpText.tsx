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
        <span className={cn('relative inline-grid min-w-0 overflow-hidden', className)}>
            <span className={cn('min-w-0 truncate', outgoing && 'invisible')}>{displayed}</span>
            {outgoing ? (
                <>
                    <span className="oc-summary-flip-out absolute inset-0 truncate" aria-hidden="true">
                        {outgoing}
                    </span>
                    <span
                        className="oc-summary-flip-in absolute inset-0 truncate"
                        onAnimationEnd={handleAnimationEnd}
                    >
                        {displayed}
                    </span>
                </>
            ) : null}
        </span>
    );
};
