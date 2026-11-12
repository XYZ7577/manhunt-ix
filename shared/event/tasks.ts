import type { Task } from '../types';

export const GAME_DATE = '2026-11-13';
export const TASKS: Task[] = [
    {
        id: 'flow-of-music',
        title: 'The Flow of Music',
        emoji: '🎶',
        media: 'photo',
        minFiles: 1,
        description:
            'Take a photo of a musical theatre or concert hall from across a lake, river, canal, or reservoir.',
        requirements: [
            'Stand on the opposite side of the water from the venue.',
            'Show both the venue and the water in your photo. Make the water as clearly visible as possible.',
        ],
    },
    {
        id: 'two-for-two',
        title: '2 for 2',
        emoji: '🏬',
        media: 'video',
        minFiles: 1,
        description: 'Visit two different 7-Eleven stores within two minutes.',
        requirements: [
            'Take a continuous video of yourself starting at one 7-Eleven and running to the other.',
            'Show both stores in the video and reach the second store within two minutes.',
            'You can try as many times as needed.',
        ],
    },
    {
        id: 'geography-dash',
        title: 'Geography Dash',
        emoji: '🧭',
        media: 'photo',
        minFiles: 3,
        description:
            'Visit and photograph at least three MRT or LRT stations with North, South, East, or West in their names.',
        requirements: [
            'Take each photo while stationary at the station and off the train.',
            'Choose from the stations below. Only one station counts from each group marked “one max”.',
            'Bedok North/South (one max) (DTL/TEL)',
            'Bukit Batok West (JRL)',
            'Choa Chu Kang West (JRL)',
            'Jurong East/West (one max) (EWL/NSL/JRL)',
            'Marina South (TEL)',
            'Marina South Pier (NSL)',
            'one-north (CCL)',
            'Pasir Ris East (CRL)',
            'Serangoon North (CRL)',
            'South View (BPLRT)',
            'Tampines East/West/North (one max) (DTL)',
            'Tuas West Road (EWL)',
            'West Coast (CRL)',
            'Woodlands North/South (one max) (TEL)',
        ],
    },
    {
        id: 'small-medium-large',
        title: 'Small, Medium, Large',
        emoji: '🌊',
        media: 'photo',
        minFiles: 3,
        description:
            'Visit and photograph a small, a medium, and a large body of water. Each must be open-air.',
        requirements: [
            'For small, photograph a pond, lake, river, or canal.',
            'For medium, photograph a reservoir.',
            'For large, photograph a strait or sea.',
        ],
    },
    {
        id: 'dam-speech',
        title: 'Damn, that’s a Dam',
        emoji: '🎥',
        media: 'video',
        minFiles: 1,
        description: 'Visit a dam and record yourself saying good things about it while standing on it.',
        requirements: [
            'Make sure your voice is audible and the dam and at least part of your body are visible.',
            'Eligible examples include Marina Barrage, Yishun Dam, Punggol Dam, Kranji Dam, and Serangoon East Dam.',
            'Pandan Tidal Gate, Gali Batu Tidal Gate, Jurong River Tidal Gate, drainage gates, flap gates, weirs, and the Johor Causeway do not count.',
        ],
    },
    {
        id: 'national-pride',
        title: 'National Pride',
        emoji: '🇸🇬',
        media: 'photo',
        minFiles: 3,
        description: 'Visit and photograph three places whose names start with “National”.',
        requirements: [
            '“National” must be the first word of each name.',
            'At least one public road must separate each place from the others.',
        ],
    },
    {
        id: 'history-spree',
        title: 'History Spree',
        emoji: '📜',
        media: 'photo',
        minFiles: 3,
        description: 'Visit and photograph all three historical locations.',
        requirements: [
            'National Gallery of Singapore',
            'Old Hill Street Police Station',
            'Sir Stamford Raffles Statue',
        ],
    },
    {
        id: 'get-high',
        title: 'Get High',
        emoji: '🏙️',
        media: 'photo',
        minFiles: 1,
        description: 'Take a photo of yourself at least 150 m above sea level or at least 45 floors up.',
        requirements: ['The summit of Bukit Timah Hill also counts.'],
    },
    {
        id: 'bird-or-plane',
        title: 'Is it a Bird? Is it a Plane?',
        emoji: '✈️',
        media: 'video',
        minFiles: 1,
        description: 'Take a one-minute video of an airplane.',
        requirements: [
            'The airplane must move at least once and stay in frame for the full minute.',
            'Film the actual airplane directly.',
        ],
    },
    {
        id: 'insurmountable',
        title: 'Insurmountable',
        emoji: '🏔️',
        bonus: true,
        media: 'photo',
        minFiles: 1,
        description:
            'Climb one of the eligible Singapore hills and take a photo showing yourself at the summit. This bonus counts toward your total task completion.',
        requirements: [
            'Send the summit photo to the organisers as soon as possible to receive immunity from being caught by hunters.',
            'Bukit Timah Hill (164 m) — 45 minutes',
            'Mount Faber (106 m) — 45 minutes',
            'Bukit Batok (100 m) — 30 minutes',
            'Bukit Kallang (100 m) — 120 minutes',
        ],
    },
];

export const ARCHIVED_TASKS: Task[] = [
    {
        id: 'rapid-order',
        title: 'Rapid Order',
        media: 'photo',
        minFiles: 1,
        timeWindows: [
            ['11:00:00', '11:01:00'],
            ['15:00:00', '15:01:00'],
        ],
        description:
            'Build the specified meal at a McDonald’s ordering kiosk within the one-minute task window.',
        requirements: [
            'Photo must be taken between 11:00–11:01 am or 3:00–3:01 pm on game day (Singapore time).',
            'Double Cheeseburger: no pickles, no mustard, double onion. Medium fries. Small Original Less Sugar Coca-Cola.',
            'Show “View cart and checkout” and the burger meal’s “View details”. Include extra photos if needed to show the order and everyone in the group.',
            'Metadata is supporting evidence; admins make the final decision.',
        ],
    },
];

export const TASK_DEFINITIONS = [...TASKS, ...ARCHIVED_TASKS];

export function getTaskDefinition(id: string): Task | undefined {
    return TASK_DEFINITIONS.find((task) => task.id === id);
}
