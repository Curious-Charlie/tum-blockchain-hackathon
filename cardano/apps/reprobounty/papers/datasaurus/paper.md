# Same Stats, Different Graphs: Generating Datasets with Varied Appearance and Identical Statistics through Simulated Annealing

Justin Matejka and George Fitzmaurice, Autodesk Research, Toronto Ontario Canada.
CHI 2017, May 06-11, 2017, Denver, CO, USA. DOI: 10.1145/3025453.3025912

(Excerpt of the passages that state numeric results. Copyright is held by the owner/author(s). Publication rights licensed to ACM.)

## Figure 1 (caption)

A collection of data sets produced by our technique. While different in appearance, each has the same summary statistics (mean, std. deviation, and Pearson's corr.) to 2 decimal places. (x̄ = 54.02, ȳ = 48.09, sd_x = 14.52, sd_y = 24.79, Pearson's r = +0.32)

## Abstract

Datasets which are identical over a number of statistical properties, yet produce dissimilar graphs, are frequently used to illustrate the importance of graphical representations when exploring data. This paper presents a novel method for generating such datasets, along with several examples. Our technique varies from previous approaches in that new datasets are iteratively generated from a seed dataset through random perturbations of individual data points, and can be directed towards a desired outcome through a simulated annealing optimization strategy.

## Method (excerpt)

Once the perturbed dataset has been accepted, either through an improved fitness value or through the simulated annealing process, the perturbed dataset is compared to the initial dataset for statistical equivalence. For the examples in this paper we consider properties to be "the same" if they are equal to two decimal places. The IsErrorOk function compares the statistics between the datasets, and if they are equal (to the specified number of decimal places), the result from the current iteration becomes the new current state.

## Example 1: Coercion Towards Target Shapes

In this first example (Figure 1), each dataset contains 182 points and are equal (to two decimal places) for the "standard" summary statistics (x/y mean, x/y standard deviation, and Pearson's correlation). Each dataset was seeded with the plot in the top left.

## Example 3: Specific Initial Dataset

The previous two examples used a rather "generic" dataset of a slightly positively correlated point cloud as the starting point of the optimization. Alternately, it is possible to begin with a very specific dataset to seed the optimization.

Figure 6 (caption): Creating a collection of datasets based on the "dinosaurus" dataset. Each dataset has the same summary statistics to two decimal places: (x̄ = 54.26, ȳ = 47.83, sd_x = 16.76, sd_y = 26.93, Pearson's r = -0.06).

Alberto Cairo produced a dataset called the "Datasaurus". Like Anscombe's Quartet, this serves as a reminder to the importance of visualizing your data, since, although the dataset produces "normal" summary statistics, the resulting plot is a picture of a dinosaur. In this example we use the "datasaurus" as the initial dataset, and create other datasets with the same summary statistics (Figure 6).

## Availability

The code and datasets presented in this work are available at www.autodeskresearch.com/publications/samestats.
