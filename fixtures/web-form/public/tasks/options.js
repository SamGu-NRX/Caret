// Option lists the task pages share: read by pages.js (native selects) and tasks.bundle.js (react-select), so a list
// changes here without rebuilding the bundle. School and city lists are served by /tasks/api, not here.
window.TASK_OPTIONS = {
  countries: ["Canada", "Germany", "India", "Ireland", "Mexico", "United Kingdom", "United States", "United States Minor Outlying Islands"],
  // The State/Province select's options by country; a country not listed has no region field.
  regions: {
    "United States": ["Alabama", "Arizona", "California", "Colorado", "Illinois", "Massachusetts", "New York", "Oregon", "Texas", "Washington"],
    Canada: ["Alberta", "British Columbia", "Manitoba", "Nova Scotia", "Ontario", "Quebec"],
  },
  degrees: ["High school diploma", "Associate's degree", "Bachelor's degree", "Master's degree", "Doctorate", "Other"],
  disciplines: ["Computer Science", "Electrical Engineering", "Mathematics", "Mechanical Engineering", "Physics", "Statistics", "Other"],
  months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  years: Array.from({ length: 16 }, (_, i) => String(2030 - i)),
  yesNo: ["Yes", "No"],
  eeoGender: ["Male", "Female", "Decline to self-identify"],
  eeoHispanic: ["Yes", "No", "Decline to self-identify"],
  eeoRace: ["American Indian or Alaskan Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "Two or More Races", "White", "Decline to self-identify"],
  eeoVeteran: ["I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran", "I don't wish to answer"],
  eeoDisability: ["Yes, I have a disability, or have had one in the past", "No, I do not have a disability and have not had one in the past", "I do not want to answer"],
};
