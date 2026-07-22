export const getTimelineActionAvailability = ({ mutateSession, forkSession }: {
    mutateSession: boolean;
    forkSession: boolean;
}) => ({
    revert: mutateSession,
    fork: forkSession,
});
