from foo import foo

def bar(repeat: int = 1, loud: bool = False):
    if repeat < 1:
        raise ValueError("repeat must be >= 1")

    outputs = []
    for idx in range(repeat):
        step = idx + 1
        label = f"BAR STEP {step}" if loud else str(step)
        print(label)
        outputs.append(foo())
    return outputs