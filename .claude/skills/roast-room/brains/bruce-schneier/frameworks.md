# frameworks.md: Bruce Schneier

Built from the limited 34-record, 72,131-word corpus listed in sources.md. Several records are excerpts or essay archive pages.

1. **Threat modeling.** Identify what needs protection, who may attack it, the attacker's capability, the harm, and which protections reduce that harm. Use it to prioritize realistic risks rather than every imaginable danger. (S010, S017)
2. **Confidentiality, integrity, availability.** Check who can read information, whether it can be changed without detection, and whether it is available when needed. Integrity failures can make available information dangerously wrong. (S003, S008)
3. **Input, processing, storage, contextual integrity.** Trace whether incoming data is authentic, transformations behave as expected, stored data remains correct, and data use fits its context. (S008)
4. **Least privilege.** Give each service only the information and authority required for its task. “The less someone knows, the less they can put you and your data at risk.” (S006)
5. **Organizational and functional decoupling.** Split information among organizations and software layers so one party cannot reconstruct or control everything. This is an architectural approach, not a universal answer. (S006, S007)
6. **Interpersonal versus social trust.** Interpersonal trust concerns a person's intentions; social trust concerns predictable behavior supported by systems, laws, and technology. Do not design a service around the illusion that a corporation is a friend. (S001, S002)
7. **Trust-enabling systems.** Morals, reputation, laws, and security technologies each help people behave predictably. The last two scale across strangers, but need oversight and enforcement. (S002)
8. **Data minimization as risk reduction.** Compare the data's practical value with breach, misuse, and retention liability. Delete data that has no defensible purpose. “The best way to secure your data is to delete it.” (S015)
9. **Security economics and liability.** Map who receives the benefit of insecure shortcuts and who suffers their costs. Change incentives through accountability, competition, or law when market rewards do not produce safe behavior. (S001, S015)
10. **Security versus security trade-offs.** Compare the security gained from one capability with the exposure it creates elsewhere. A surveillance or offensive capability can weaken the same people it is meant to protect. (S015)
11. **Interoperability and exit.** Prefer standards and architectures that allow switching providers and distributing control. Lock-in makes users dependent on the provider's security choices. (S004)
12. **Whole-system security.** Include devices, software, networks, data stores, operators, organizations, and policy in the analysis. A secure component can still sit inside an insecure system. (S015, S016)
