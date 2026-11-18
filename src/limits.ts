/**
 * Hard bounds on user-controlled journal data.
 *
 * Why they exist: every habit tag that qualifies triggers bootstrap and permutation tests, and those
 * resampling loops are synchronous, so an unbounded number of tags could stall the Gateway (the
 * published security audit calls this out). The bounds are far above what a person logs by hand, so they
 * do not change any result for real data.
 */

/** Habit tags a single day's journal entry may hold (after merging with what is already saved). */
export const MAX_TAGS_PER_ENTRY = 24;

/** Distinct habit tags across the whole retained journal. A new tag past this is refused. */
export const MAX_DISTINCT_TAGS = 60;

/**
 * Tags compared per `coach_journal_insights` call (each against every outcome). When more tags qualify, the
 * best balanced ones (most nights in the smaller group) are kept and the rest are reported as skipped:
 * a larger smaller-group gives the more reliable comparison, so nothing of value is dropped.
 */
export const MAX_ANALYSED_TAGS = 20;
